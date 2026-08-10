/**
 * Messenger friends feature — request/response opcodes and list layout.
 * Packet dispatch and DB logic live in `server.ts`.
 */
export {
  OP_FRIEND_LIST_REQ,
  OP_FRIEND_LIST,
  OP_FRIEND_REFRESH,
  OP_FRIEND_ADD,
  OP_FRIEND_REPLY,
  OP_FRIEND_ADD_ACK,
  OP_FRIEND_ONLINE,
  SLOT_SIZE,
  MAX_FRIENDS,
  NAME_LEN,
  FRIEND_LIST_TOTAL,
  RESULT_OK,
  RESULT_FAIL,
  RESULT_FULL,
} from "./opcodes.js";
