import { PIPE_NAME_DEFAULT } from "@mirza-harness/shared";
import { HOSTD_VERSION } from "./doctor";
import { startServer } from "./server";

const pipe = process.env.MIRZA_HOSTD_PIPE ?? PIPE_NAME_DEFAULT;
const server = await startServer(pipe);
console.log(`[hostd] v${HOSTD_VERSION} siap — pipe: ${pipe} (pid ${process.pid})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[hostd] ${sig} — shutdown rapi`);
    server.close(() => process.exit(0));
  });
}
