import { describe, expect, test } from "bun:test";
import { PENDING_CAP, defaultAccess, type Access } from "@mirza-harness/shared";
import { gate, type GateInput } from "../src/gate";

function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    chatType: "private",
    chatId: "u1",
    senderId: "u1",
    ...overrides,
  };
}

function withPending(access: Access, entries: Record<string, Access["pending"][string]>): Access {
  return { ...access, pending: { ...access.pending, ...entries } };
}

const NOW = 1_700_000_000_000;

describe("gate — dmPolicy disabled", () => {
  test("private chat drops regardless of allowFrom", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "disabled", allowFrom: ["u1"] };
    const result = gate(baseInput(), access, { now: NOW });
    expect(result.action).toBe("drop");
  });

  test("group chat drops regardless of group policy", () => {
    const access: Access = {
      ...defaultAccess(),
      dmPolicy: "disabled",
      groups: { g1: { requireMention: false, allowFrom: [] } },
    };
    const result = gate(baseInput({ chatType: "group", chatId: "g1" }), access, { now: NOW });
    expect(result.action).toBe("drop");
  });

  test("dmPolicy disabled is a kill-switch over SEC-2: permission-reply in private+allowFrom still drops", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "disabled", allowFrom: ["u1"] };
    const result = gate(baseInput({ isPermissionReply: true }), access, { now: NOW });
    expect(result.action).toBe("drop");
    if (result.action === "drop") expect(result.reason).toContain("disabled");
  });
});

describe("gate — dmPolicy allowlist × chatType private", () => {
  test("sender in allowFrom -> deliver", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "allowlist", allowFrom: ["u1"] };
    const result = gate(baseInput(), access, { now: NOW });
    expect(result.action).toBe("deliver");
  });

  test("sender not in allowFrom -> drop (no pairing offered)", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "allowlist", allowFrom: [] };
    const result = gate(baseInput(), access, { now: NOW });
    expect(result.action).toBe("drop");
  });
});

describe("gate — dmPolicy pairing × chatType private", () => {
  test("sender in allowFrom -> deliver", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };
    const result = gate(baseInput(), access, { now: NOW });
    expect(result.action).toBe("deliver");
  });

  test("stranger, no pending -> pairing-reply with fresh code, isResend false", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    const result = gate(baseInput(), access, { now: NOW });
    expect(result.action).toBe("pairing-reply");
    if (result.action === "pairing-reply") {
      expect(result.isResend).toBe(false);
      expect(result.code).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  test("stranger with existing non-expired pending -> resend same code", () => {
    let access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    access = withPending(access, {
      abc123: { senderId: "u1", chatId: "u1", createdAt: NOW, expiresAt: NOW + 1000, replies: 1 },
    });
    const result = gate(baseInput(), access, { now: NOW });
    expect(result.action).toBe("pairing-reply");
    if (result.action === "pairing-reply") {
      expect(result.isResend).toBe(true);
      expect(result.code).toBe("abc123");
    }
  });

  test("stranger with pending already replied twice -> drop (reply cap)", () => {
    let access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    access = withPending(access, {
      abc123: { senderId: "u1", chatId: "u1", createdAt: NOW, expiresAt: NOW + 1000, replies: 2 },
    });
    const result = gate(baseInput(), access, { now: NOW });
    expect(result.action).toBe("drop");
  });

  test("expired pending entry for sender is ignored -> treated as fresh", () => {
    let access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    access = withPending(access, {
      abc123: { senderId: "u1", chatId: "u1", createdAt: NOW - 2000, expiresAt: NOW - 1000, replies: 1 },
    });
    const result = gate(baseInput(), access, { now: NOW });
    expect(result.action).toBe("pairing-reply");
    if (result.action === "pairing-reply") expect(result.isResend).toBe(false);
  });

  test(`pending cap ${PENDING_CAP} (konsisten access-store) -> drop for new stranger`, () => {
    let access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    const entries: Record<string, Access["pending"][string]> = {};
    for (let i = 0; i < PENDING_CAP; i++) {
      entries[`code${i}`] = {
        senderId: `other-${i}`,
        chatId: `other-${i}`,
        createdAt: NOW,
        expiresAt: NOW + 1000,
        replies: 1,
      };
    }
    access = withPending(access, entries);
    const result = gate(baseInput({ senderId: "u-new" }), access, { now: NOW });
    expect(result.action).toBe("drop");
  });

  test("pending cap does not block a sender who already has an entry", () => {
    let access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    const entries: Record<string, Access["pending"][string]> = {};
    for (let i = 0; i < PENDING_CAP; i++) {
      entries[`code${i}`] = {
        senderId: i === 0 ? "u1" : `other-${i}`,
        chatId: i === 0 ? "u1" : `other-${i}`,
        createdAt: NOW,
        expiresAt: NOW + 1000,
        replies: 1,
      };
    }
    access = withPending(access, entries);
    const result = gate(baseInput({ senderId: "u1" }), access, { now: NOW });
    expect(result.action).toBe("pairing-reply");
    if (result.action === "pairing-reply") {
      expect(result.isResend).toBe(true);
      expect(result.code).toBe("code0");
    }
  });
});

describe("gate — group/supergroup requireMention & allowFrom", () => {
  function groupAccess(policy: Partial<{ requireMention: boolean; allowFrom: string[] }> = {}): Access {
    return {
      ...defaultAccess(),
      groups: { g1: { requireMention: true, allowFrom: [], ...policy } },
    };
  }

  test("no policy for chat -> drop", () => {
    const access: Access = { ...defaultAccess(), groups: {} };
    const result = gate(baseInput({ chatType: "group", chatId: "g1" }), access, { now: NOW });
    expect(result.action).toBe("drop");
  });

  test("requireMention true, no mention -> drop", () => {
    const access = groupAccess({ requireMention: true });
    const result = gate(baseInput({ chatType: "group", chatId: "g1" }), access, { now: NOW });
    expect(result.action).toBe("drop");
  });

  test("requireMention true, mentionsBot -> deliver", () => {
    const access = groupAccess({ requireMention: true });
    const result = gate(baseInput({ chatType: "group", chatId: "g1", mentionsBot: true }), access, { now: NOW });
    expect(result.action).toBe("deliver");
  });

  test("requireMention true, replyToBot -> deliver", () => {
    const access = groupAccess({ requireMention: true });
    const result = gate(baseInput({ chatType: "group", chatId: "g1", replyToBot: true }), access, { now: NOW });
    expect(result.action).toBe("deliver");
  });

  test("requireMention true, text matches mentionPatterns -> deliver", () => {
    const access: Access = {
      ...groupAccess({ requireMention: true }),
      mentionPatterns: ["hey\\s+claude"],
    };
    const result = gate(
      baseInput({ chatType: "supergroup", chatId: "g1", text: "hey claude, help" }),
      access,
      { now: NOW },
    );
    expect(result.action).toBe("deliver");
  });

  test("requireMention false -> deliver without mention", () => {
    const access = groupAccess({ requireMention: false });
    const result = gate(baseInput({ chatType: "group", chatId: "g1" }), access, { now: NOW });
    expect(result.action).toBe("deliver");
  });

  test("group allowFrom set, sender not listed -> drop even with mention", () => {
    const access = groupAccess({ requireMention: true, allowFrom: ["member-1"] });
    const result = gate(
      baseInput({ chatType: "group", chatId: "g1", senderId: "stranger", mentionsBot: true }),
      access,
      { now: NOW },
    );
    expect(result.action).toBe("drop");
  });

  test("group allowFrom set, sender listed + mention -> deliver", () => {
    const access = groupAccess({ requireMention: true, allowFrom: ["member-1"] });
    const result = gate(
      baseInput({ chatType: "group", chatId: "g1", senderId: "member-1", mentionsBot: true }),
      access,
      { now: NOW },
    );
    expect(result.action).toBe("deliver");
  });
});

describe("SEC-1 — isInfoCommand (/context /version class) never leaks under dmPolicy pairing", () => {
  test("stranger in private+pairing sending an info command -> pairing-reply, not deliver (no info leak)", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    const result = gate(baseInput({ isInfoCommand: true }), access, { now: NOW });
    expect(result.action).not.toBe("deliver");
    expect(result.action).toBe("pairing-reply");
  });

  test("allowFrom member in private+pairing sending an info command -> deliver", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };
    const result = gate(baseInput({ isInfoCommand: true }), access, { now: NOW });
    expect(result.action).toBe("deliver");
  });

  test("stranger in private+allowlist sending an info command -> drop, not deliver", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "allowlist" };
    const result = gate(baseInput({ isInfoCommand: true }), access, { now: NOW });
    expect(result.action).toBe("drop");
  });

  test("info command in a group is always dropped (commands are DM-only), even with mention + allowlisted sender", () => {
    const access: Access = {
      ...defaultAccess(),
      groups: { g1: { requireMention: true, allowFrom: ["u1"] } },
    };
    const result = gate(
      baseInput({ chatType: "group", chatId: "g1", isInfoCommand: true, mentionsBot: true }),
      access,
      { now: NOW },
    );
    expect(result.action).toBe("drop");
  });
});

describe("SEC-2 — isMetaCommand / isPermissionReply restricted to private + allowFrom", () => {
  test("private chat, sender in allowFrom -> deliver (meta-command)", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "allowlist", allowFrom: ["u1"] };
    const result = gate(baseInput({ isMetaCommand: true }), access, { now: NOW });
    expect(result.action).toBe("deliver");
  });

  test("private chat, sender in allowFrom -> deliver (permission-reply)", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };
    const result = gate(baseInput({ isPermissionReply: true }), access, { now: NOW });
    expect(result.action).toBe("deliver");
  });

  test("private chat, sender NOT in allowFrom -> drop with reason (meta-command)", () => {
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    const result = gate(baseInput({ isMetaCommand: true }), access, { now: NOW });
    expect(result.action).toBe("drop");
    if (result.action === "drop") expect(result.reason).toBeTruthy();
  });

  test("group member who IS in the group's own allowFrom cannot trigger a meta-command", () => {
    const access: Access = {
      ...defaultAccess(),
      groups: { g1: { requireMention: false, allowFrom: ["member-1"] } },
    };
    const result = gate(
      baseInput({ chatType: "group", chatId: "g1", senderId: "member-1", isMetaCommand: true }),
      access,
      { now: NOW },
    );
    expect(result.action).toBe("drop");
    if (result.action === "drop") expect(result.reason).toBeTruthy();
  });

  test("supergroup, sender in DM allowFrom (unrelated) but chatType isn't private -> drop (permission-reply)", () => {
    const access: Access = { ...defaultAccess(), allowFrom: ["u1"] };
    const result = gate(
      baseInput({ chatType: "supergroup", chatId: "g1", senderId: "u1", isPermissionReply: true }),
      access,
      { now: NOW },
    );
    expect(result.action).toBe("drop");
  });
});

describe("gate — unknown chatType", () => {
  test("drops", () => {
    const access: Access = { ...defaultAccess(), allowFrom: ["u1"] };
    const result = gate(baseInput({ chatType: "channel" as GateInput["chatType"] }), access, { now: NOW });
    expect(result.action).toBe("drop");
  });
});
