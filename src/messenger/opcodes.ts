/** Messenger wire opcodes. */
export const OP_READY = 0x0009;
export const OP_GAMELOG = 0x000b;
export const OP_FRIEND_LIST_REQ = 0x000c;
export const OP_LETTER_LIST_REQ = 0x0040;
export const OP_LETTER_LIST = 0x0041;
export const OP_LETTER_SEND = 0x0042;
export const OP_LETTER_RECV = 0x0043;
export const OP_LETTER_DEL = 0x0045;
export const OP_LETTER_DEL_ALL = 0x0046;
export const OP_LETTER_READ = 0x0047;
export const OP_FRIEND_LIST = 0x0049;
export const OP_FRIEND_REFRESH = 0x0048;
export const OP_FRIEND_ADD = 0x004a;
export const OP_FRIEND_REPLY = 0x004b;
export const OP_FRIEND_ADD_ACK = 0x004c;
export const OP_FRIEND_ONLINE = 0x004f;
export const OP_KEEPALIVE = 0x005a;

export const SLOT_SIZE = 0x20;
export const MAX_FRIENDS = 30;
export const NAME_LEN = 20;
export const FRIEND_LIST_TOTAL = 0x3cc;

export const LETTER_SLOT_SIZE = 0x21a;
export const MAX_LETTERS = 30;
export const LETTER_BODY_LEN = 512;
export const LETTER_LIST_TOTAL = 0x3f18;

export const RESULT_OK = 0;
export const RESULT_FAIL = 1;
export const RESULT_FULL = 2;
