import dgram from "node:dgram";
import net from "node:net";
import { config } from "../config.js";
import { peelGame, opcodeOf, bufToHex } from "../net/packet.js";
import { decodeFieldFrame } from "../net/fieldCodec.js";
import { PACKET_MAGIC } from "../protocol/magic.js";
import {
  loadMonsters,
  tickRespawns,
  tickWander,
  buildMonRegen,
  LIVE_INTERVAL_MS,
} from "./features/monsters/index.js";
import { loadDropRules, tickGroundDrops, buildDropClear } from "./features/drops/index.js";
import { loadCashShopFromDb } from "./features/cashshop/index.js";
import { loadPrices } from "./features/prices/index.js";
import { endPShopIfActive } from "./features/pshop/index.js";
import { getParty } from "./features/party/index.js";
import {
  type Player,
  players,
  send,
  broadcastMap,
  setFieldUdp,
} from "./player.js";
import {
  initPacket,
  makeFieldKeys,
  bumpHelloId,
  FIELD_HELLO_KEY1,
  FIELD_HELLO_KEY2,
  FIELD_HELLO_TOKEN,
} from "./packets/hello.js";
import { leavePacket } from "./packets/ui.js";
import { broadcastMonRegen, maybeHibernateMap } from "./features/monsters/runtime.js";
import { MOVE_OPS, relayPeerAction } from "./handlers/movement.js";
import { handlePacket } from "./handlers/router.js";
import { leaveParty } from "./handlers/party.js";
import { cancelTradeFor } from "./handlers/trade.js";
import { clearAllSkillEffects } from "./handlers/skills.js";
import { tickMonsterTouch, hurtPlayer } from "./handlers/combat.js";
import { countOnline } from "./online-count.js";

export async function startFieldServer(): Promise<{ tcp: net.Server; udp: dgram.Socket }> {
  await loadDropRules();
  await loadCashShopFromDb();
  await loadPrices();
  await loadMonsters();

  setInterval(() => {
    const now = Date.now();
    const activeMaps = new Set<string>();
    const wanderTargets: { map: number; region: number; x: number; y: number; charId: number }[] =
      [];
    for (const pl of players.values()) {
      if (!pl.loggedIn || !pl.fieldEntered || !pl.monCombatReady) continue;
      activeMaps.add(`${pl.map}/${pl.region}`);
      if (pl.alive) {
        wanderTargets.push({
          map: pl.map,
          region: pl.region,
          x: pl.x,
          y: pl.y,
          charId: pl.charId,
        });
      }
    }

    // Ground drops (items/money/souls) expire after TTL — clear so they don't linger for hours.
    for (const ev of tickGroundDrops(now)) {
      broadcastMap(ev.drop.map, ev.drop.region, buildDropClear(0, ev.drop));
    }

    if (activeMaps.size > 0) {
      tickMonsterTouch();
      const revived = tickRespawns(now, activeMaps);
      for (const m of revived) {
        broadcastMonRegen(m.map, m.region, buildMonRegen(m));
      }
      const { moves, attacks } = tickWander(now, activeMaps, wanderTargets);
      for (const w of moves) {
        broadcastMonRegen(w.map, w.region, w.pkt);
      }
      for (const a of attacks) {
        // State 3 first — Hit spark on victim so the client plays flinch + may send 0x46.
        // Delay HP apply so the hit anim is not skipped by an immediate 0x51.
        broadcastMonRegen(a.map, a.region, a.pkt);
        const charId = a.charId;
        const dmg = a.dmg;
        const map = a.map;
        const region = a.region;
        setTimeout(() => {
          const victim = players.get(charId);
          if (
            !victim ||
            !victim.loggedIn ||
            !victim.alive ||
            victim.map !== map ||
            victim.region !== region
          ) {
            return;
          }
          // Already applied via client CHAR_DAMAGE 0x46
          if (Date.now() - victim.lastTouchAt < 700) return;
          void hurtPlayer(victim, dmg, "mon-aggro-atk");
        }, 280);
      }
    }
  }, LIVE_INTERVAL_MS);

  const udp = dgram.createSocket("udp4");
  setFieldUdp(udp);
  udp.on("message", (msg, rinfo) => {
    if (msg.length < 12) return;
    const magic = msg.readUInt16LE(0);
    if (magic !== PACKET_MAGIC) return;
    const op = msg.readUInt16LE(2);
    if (!MOVE_OPS.has(op)) return;
    const charId = msg.length >= 16 ? msg.readUInt32LE(12) : 0;
    let p = players.get(charId);
    if (!p) {
      for (const pl of players.values()) {
        if (pl.udpPort === rinfo.port && pl.udpHost === rinfo.address) {
          p = pl;
          break;
        }
      }
    }
    if (!p || !p.fieldEntered) return;
    p.udpPort = rinfo.port;
    p.udpHost = rinfo.address;
    relayPeerAction(p, msg, op);
  });
  udp.bind(config.udpPort, config.fieldHost, () => {
    console.log(`[field-udp] ${config.fieldHost}:${config.udpPort}`);
  });

  const tcp = net.createServer((sock) => {
    const p: Player = {
      sock,
      buf: Buffer.alloc(0),
      charId: 0,
      accountId: 0,
      name: "",
      map: 1,
      region: 1,
      x: 0,
      y: 0,
      level: 1,
      exp: 0,
      mexp: 30,
      job: 0,
      job2: -1,
      job3: -1,
      hp: 50,
      maxHp: 50,
      mp: 50,
      maxMp: 50,
      minAtk: 10,
      maxAtk: 10,
      minMag: 0,
      maxMag: 0,
      def: 0,
      money: 0,
      soul: 0,
      maxSoul: 100,
      gm: 0,
      loggedIn: false,
      fishing: false,
      alive: true,
      spendUseSlot: 0xff,
      petUseSlot: 0xff,
      pendingWarp: false,
      fieldEntered: false,
      touchGraceUntil: 0,
      lastTouchAt: 0,
      pktChain: Promise.resolve(),
      monCombatReady: false,
      magic: PACKET_MAGIC,
      unk: 0,
      helloSent: false,
      fieldKeys: makeFieldKeys(FIELD_HELLO_KEY1, FIELD_HELLO_KEY2),
      udpPort: 0,
      udpHost: "",
      skillTimers: new Map(),
      skillMods: new Map(),
      eventBuff: undefined,
    };
    // client waits for hello 0x14 before sending field login; the client can send first
    // but also accepts an immediate hello. Magic/token must match client (0x37 / 0x1E488BF5).
    // Unique hello id per connection (avoid always-122 when two local clients connect).
    const helloId = bumpHelloId();
    console.log("[field] connect from", sock.remoteAddress, sock.remotePort);
    p.helloSent = true;
    send(p, initPacket(helloId, p.magic));
    console.log(
      `[field] hello 0x14 sent magic=0x${p.magic.toString(16)} id=${helloId} token=0x${FIELD_HELLO_TOKEN.toString(16)}`,
    );

    sock.on("data", (chunk) => {
      console.log(`[field] raw +${chunk.length}B ${bufToHex(chunk.subarray(0, Math.min(chunk.length, 256)))}`);
      p.buf = Buffer.concat([p.buf, chunk]);
      const { frames, rest } = peelGame(p.buf);
      p.buf = rest;
      if (!frames.length && p.buf.length >= 12) {
        console.log(
          `[field] buffered ${p.buf.length}B waiting (op=0x${p.buf.readUInt16LE(2).toString(16)} lenField=${p.buf.readUInt16LE(4)})`,
        );
      }
      p.pktChain = p.pktChain.then(async () => {
        for (const frame of frames) {
          try {
            let pkt = frame;
            const outerOp = frame.length >= 4 ? frame.readUInt16LE(2) : 0;
            if (outerOp === 0x81) {
              const decoded = decodeFieldFrame(frame, p.fieldKeys);
              if (!decoded) {
                console.warn(`[field] failed to decode 0x81 frame len=${frame.length}`);
                continue;
              }
              pkt = decoded;
              console.log(
                `[field] decoded 0x81 -> op=0x${opcodeOf(pkt).toString(16)} len=${pkt.length}`,
              );
            }
            if (pkt.length >= 12) {
              const innerMagic = pkt.readUInt16LE(0);
              // Outer 0x81 stores uncomp size in the magic field — ignore that.
              if (innerMagic === PACKET_MAGIC) {
                p.magic = innerMagic;
              }
              p.unk = pkt.readUInt32LE(8);
            }
            await handlePacket(p, pkt);
          } catch (e) {
            console.error("[field] err", e);
          }
        }
      });
    });

    sock.on("close", () => {
      if (p.loggedIn && p.charId) {
        const leftMap = p.map;
        const leftRegion = p.region;
        const shopEnd = endPShopIfActive(p.charId);
        if (shopEnd) broadcastMap(leftMap, leftRegion, shopEnd);
        void cancelTradeFor(p, true).catch((e) => console.error("[field] trade cleanup", e));
        if (getParty(p.charId)) leaveParty(p);
        broadcastMap(leftMap, leftRegion, leavePacket(p.charId), p.charId);
        players.delete(p.charId);
        countOnline();
        maybeHibernateMap(leftMap, leftRegion);
      }
      if (p.fishTimer) clearTimeout(p.fishTimer);
      if (p.monCombatTimer) clearTimeout(p.monCombatTimer);
      clearAllSkillEffects(p);
    });
    sock.on("error", () => undefined);
  });

  tcp.listen(config.fieldPort, config.fieldHost, () => {
    console.log(`[field] listening ${config.fieldHost}:${config.fieldPort}`);
  });

  return { tcp, udp };
}
