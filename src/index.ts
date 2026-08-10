import { initDb } from "./db.js";
import { config } from "./config.js";
import { startLoginServer } from "./login/server.js";
import { startChannelServer } from "./channel/server.js";
import { startFieldServer } from "./field/server.js";
import { startMessengerServer } from "./messenger/server.js";

async function main(): Promise<void> {
  console.log("Ghost Online Node Server");
  await initDb();
  startLoginServer();
  startChannelServer();
  await startFieldServer();
  startMessengerServer(
    [...new Set([config.messengerPort, config.messengerPortAlt].filter((p) => p > 0))],
  );
  console.log(
    `All services up → ${config.loginHost}:${config.loginPort}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
