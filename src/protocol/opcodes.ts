/**
 * Named wire opcodes used across login / channel / field / messenger.
 * Values are behavior-identical to prior bare hex literals.
 */

// --- Field (game) ---
export const OP_FIELD_HELLO = 0x0014;
export const OP_FIELD_BIND = 0x0018;
export const OP_FIELD_CHAT = 0x0017;
export const OP_FIELD_GM = 0x0010;
export const OP_FIELD_ENTER_REQ = 0x001d;
export const OP_FIELD_ENTER_REQ_ALT = 0x011d;
export const OP_FIELD_ENTER = 0x00db;
export const OP_FIELD_COMPRESSED = 0x0081;
export const OP_FIELD_WARP = 0x0085;
export const OP_FIELD_MAP_INFO = 0x001c;
export const OP_FIELD_CHAR_ALL = 0x0050;
export const OP_FIELD_ENTER_PLAYER = 0x001e;
export const OP_FIELD_HP_MP = 0x0051;
export const OP_FIELD_ATTACK = 0x0045;
export const OP_FIELD_TOUCH = 0x0046;
export const OP_FIELD_DEAD_REQ = 0x0047;
export const OP_FIELD_PICKUP = 0x004c;
export const OP_FIELD_FISH_REQ = 0x00e0;
export const OP_FIELD_FISH_ACK = 0xe1;
export const OP_FIELD_MON_ALL = 0x0042;
export const OP_FIELD_MON_REGEN = 0x003f;
export const OP_FIELD_MON_INFO = 0x0038;

// Cash / shop / bags (field)
export const OP_CASH_OPEN = 0x00e4;
export const OP_CASH_CLOSE = 0x00e5;
export const OP_CASH_BUY = 0x00e7;
export const OP_CASH_GIFT = 0x00e9;
export const OP_CASH_WAREHOUSE = 0x00ef;
export const OP_CASH_UNSEAL = 0x0140;
export const OP_SPEND_USE = 0x00fc;
export const OP_SHOUT = 0x015b;
export const OP_INVEN_SPLIT = 0x0022;

// Party
export const OP_PARTY_INVITE = 0x009b;
export const OP_PARTY_REPLY = 0x009c;
export const OP_PARTY_LEAVE = 0x009f;
export const OP_PARTY_KICK = 0x00a0;

// Trade
export const OP_TRADE_INVITE = 0x0092;
export const OP_TRADE_REPLY = 0x0093;
export const OP_TRADE_READY = 0x0094;
export const OP_TRADE_CONFIRM = 0x0095;
export const OP_TRADE_CANCEL = 0x0096;
export const OP_TRADE_PUT = 0x0099;

// Personal shop
export const OP_PSHOP_START = 0x00d5;
export const OP_PSHOP_START_ALT = 0x01a4;

// Messenger
export const OP_MSG_READY = 0x0009;
export const OP_MSG_GAMELOG = 0x000b;
export const OP_MSG_FRIEND_LIST_REQ = 0x000c;
export const OP_MSG_LETTER_LIST_REQ = 0x0040;
export const OP_MSG_LETTER_LIST = 0x0041;
export const OP_MSG_LETTER_SEND = 0x0042;
export const OP_MSG_LETTER_RECV = 0x0043;
export const OP_MSG_LETTER_DEL = 0x0045;
export const OP_MSG_LETTER_DEL_ALL = 0x0046;
export const OP_MSG_LETTER_READ = 0x0047;
export const OP_MSG_FRIEND_REFRESH = 0x0048;
export const OP_MSG_FRIEND_LIST = 0x0049;
export const OP_MSG_FRIEND_ADD = 0x004a;
export const OP_MSG_FRIEND_REPLY = 0x004b;
export const OP_MSG_FRIEND_ADD_ACK = 0x004c;
export const OP_MSG_FRIEND_ONLINE = 0x004f;
export const OP_MSG_KEEPALIVE = 0x005a;

// Channel
export const OP_CHANNEL_LOGIN = 0x0008;
export const OP_CHANNEL_CHAR_LIST = 0x000b;
export const OP_CHANNEL_CREATE = 0x000c;
export const OP_CHANNEL_DELETE = 0x000d;
export const OP_CHANNEL_SELECT = 0x000e;
export const OP_CHANNEL_CHAR_STATUS = 0x000f;
