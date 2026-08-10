/** Character select: 2 slots × 88 bytes + 16-byte header = 192. */
export const CHAR_SLOTS = 2;

/** Slot size in CHARSTATUS payload. */
export const CHAR_SLOT_BYTES = 88;

/** Default soul equip for new characters. */
export const NEW_CHAR_SOUL_ITEM_ID = 8_510_011;

/** Channel opcodes */
export const OP_CHARSTATUS = 0x0008;
export const OP_CREATE_CHAR = 0x000a;
export const OP_CREATE_ACK = 0x000b;
export const OP_CHECK_NAME = 0x000c;
export const OP_NAME_ACK = 0x000d;
export const OP_DELETE_CHAR = 0x000e;
export const OP_DELETE_ACK = 0x000f;

/** Equip slot positions in CHARSTATUS packet */
export const EQUIP_SLOT_WEAPON = 0;
export const EQUIP_SLOT_ARMOR = 1;
export const EQUIP_SLOT_CAPE = 4;
export const EQUIP_SLOT_HAT = 6;
export const EQUIP_SLOT_EYE = 8;
export const EQUIP_SLOT_FACE_UPPER = 9;
export const EQUIP_SLOT_CLOTHES = 11;
export const EQUIP_SLOT_FACE_LOWER = 12;
export const EQUIP_SLOT_HAIR = 7;
