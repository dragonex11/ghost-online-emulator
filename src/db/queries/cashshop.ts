export const DELETE_CASH_INVEN_BY_ID = `DELETE FROM cash_inven WHERE id=?`;

export const INSERT_CASH_INVEN = `INSERT INTO cash_inven (charid, slot, itemid, amount, islocked, term) VALUES (?,?,?,?,?,?)`;

export const INSERT_GIFTS = `INSERT INTO gifts (name, itemid, itemname, amount, islocked, term, receive, sender) VALUES (?,?,?,1,1,-1,0,?)`;

export const SELECT_CASH_INVEN_BY_CHARID = `SELECT slot, itemid, amount, islocked, term FROM cash_inven WHERE charid = ? ORDER BY slot`;

export const SELECT_CASH_INVEN_BY_CHARID_2 = `SELECT slot FROM cash_inven WHERE charid = ?`;

export const SELECT_CASH_INVEN_BY_CHARID_3 = `SELECT slot FROM cash_inven WHERE charid=?`;

export const SELECT_CASH_INVEN_BY_CHARID_AND_SLOT = `SELECT * FROM cash_inven WHERE charid=? AND slot=?`;

export const SELECT_CASH_SHOP = `SELECT category, item_id AS itemId, price, bargain, term, flag FROM cash_shop ORDER BY category, id`;

export const SELECT_GIFTS_BY_NAME_AND_RECEIVE = `SELECT id, itemid, amount, islocked, term FROM gifts WHERE name=? AND receive=0`;

export const UPDATE_CASH_INVEN_BY_CHARID_AND_SLOT = `UPDATE cash_inven SET islocked=0 WHERE charid=? AND slot=?`;

export const UPDATE_CASH_INVEN_BY_CHARID_AND_SLOT_2 = `UPDATE cash_inven SET islocked=0 WHERE charid=? AND slot=? AND FLOOR(itemid/100000)=92`;

export const UPDATE_GIFTS_BY_ID = `UPDATE gifts SET receive=1 WHERE id=?`;
