/**
 * Client packet header magic (u16 LE at offset 0).
 * CRC field is computed as (opcode + totalLen + magic) & 0xffff.
 */
export const PACKET_MAGIC = 0x0037;

export function packetMagicOrDefault(magic: number | undefined | null): number {
  return magic || PACKET_MAGIC;
}
