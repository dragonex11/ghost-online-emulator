/** Peer-visible action packets relayed UDP→TCP (and TCP→TCP). Position-bearing: 0x27/DD/29/2A. */
export const MOVE_OPS = new Set([
  0x27, 0xdd, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x24, // move / jump / speed / basic attack
  0x2e, 0x31, // P_SPELL_C / P_SKILL_C — skill cast anims
  0x10b, 0x10c, 0x10d, 0x10e, // PET_MOVE / MOVETO / BIRD / BIRDTO
  0x110, 0x111, 0x116, // PET_JUMP / ATTACK / related pet action
]);

/** Client chat types at pkt+0x10: 0=map (bubble), 1=guild (cyan), 3=whisper. */
export const CHAT_TYPE_MAP = 0;
export const CHAT_TYPE_WHISPER = 3;

export function isCashMall(map: number, region: number): boolean {
  return (map === 77 && region === 1) || (map === 1 && region === 77);
}
