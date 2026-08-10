/**
 * Messenger mail / letters feature — request/response opcodes and list layout.
 * Packet dispatch and DB logic live in `server.ts`.
 */
export {
  OP_LETTER_LIST_REQ,
  OP_LETTER_LIST,
  OP_LETTER_SEND,
  OP_LETTER_RECV,
  OP_LETTER_DEL,
  OP_LETTER_DEL_ALL,
  OP_LETTER_READ,
  LETTER_SLOT_SIZE,
  MAX_LETTERS,
  LETTER_BODY_LEN,
  LETTER_LIST_TOTAL,
  NAME_LEN,
} from "./opcodes.js";
