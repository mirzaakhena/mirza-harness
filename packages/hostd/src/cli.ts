import net from "node:net";
import { PIPE_NAME_DEFAULT } from "@mirza-harness/shared";

const [cmd] = process.argv.slice(2);
if (cmd !== "doctor") {
  console.error("pakai: cli.ts doctor");
  process.exit(2);
}

const pipe = process.env.MIRZA_HOSTD_PIPE ?? PIPE_NAME_DEFAULT;
const sock = net.connect(pipe, () => {
  sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doctor" }) + "\n");
});
let buf = "";
sock.on("data", d => {
  buf += d.toString("utf8");
  const nl = buf.indexOf("\n");
  if (nl >= 0) {
    console.log(JSON.stringify(JSON.parse(buf.slice(0, nl)).result, null, 2));
    sock.end();
  }
});
sock.on("error", err => {
  console.error(`hostd tidak terjangkau di ${pipe}: ${err.message}`);
  process.exit(1);
});
