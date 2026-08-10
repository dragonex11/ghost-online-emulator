export const DELETE_EQUIP_BY_CHARID = `DELETE FROM equip WHERE charid = ?`;

export const DELETE_EQUIP_BY_CHARID_2 = `DELETE FROM equip WHERE charid=? AND pos1=? AND pos2=?`;

export const DELETE_EQUIP_BY_CHARID_3 = `DELETE FROM equip WHERE charid=? AND pos1=0 AND pos2=10`;

export const DELETE_EQUIP_BY_CHARID_4 = `DELETE FROM equip WHERE charid=? AND pos1=0 AND pos2=7`;

export const DELETE_EQUIP_BY_CHARID_5 = `DELETE FROM equip WHERE charid=? AND pos1=0 AND pos2=8`;

export const DELETE_OTHER_BY_CHARID = `DELETE FROM other WHERE charid = ?`;

export const DELETE_OTHER_BY_CHARID_2 = `DELETE FROM other WHERE charid=? AND pos1=4 AND pos2=?`;

export const DELETE_SPEND_BY_CHARID = `DELETE FROM spend WHERE charid = ?`;

export const DELETE_SPEND_BY_CHARID_2 = `DELETE FROM spend WHERE charid=? AND pos1=3 AND pos2=?`;

export const INSERT_EQUIP = `INSERT INTO equip (equipid,type,charid,pos1,pos2,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse,isspecial)
       VALUES (?,?,?,?,?,0,0,0,0,0,0,0,0,0,0,0,0,?,?,0)`;

export const INSERT_EQUIP_2 = `INSERT INTO equip (equipid,type,charid,pos1,pos2,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse,isspecial) VALUES (?,?,?,0,10,0,0,0,0,0,0,0,0,0,0,0,0,0,-1,0)`;

export const INSERT_EQUIP_3 = `INSERT INTO equip (equipid,type,charid,pos1,pos2,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse,isspecial) VALUES (?,?,?,0,7,0,0,0,0,0,0,0,0,0,0,0,0,?,?,0)`;

export const INSERT_EQUIP_4 = `INSERT INTO equip (equipid,type,charid,pos1,pos2,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse,isspecial) VALUES (?,?,?,0,8,0,0,0,0,0,0,0,0,0,0,0,0,?,?,0)`;

export const INSERT_OTHER = `INSERT INTO other (otherid,type,charid,pos1,pos2,amount,iscash,timeuse,isspecial) VALUES (?,?,?,?,?,?,?,?,0)`;

export const INSERT_PETS = `INSERT INTO pets (cid, itemId, decorateId, name, level, hp, mp, exp, iscash, type, slot) VALUES (?,?,0,?,1,100,100,0,?,5,?)`;

export const INSERT_SPEND = `INSERT INTO spend (spendid,itemid,charid,pos1,pos2,amount,iscash,timeuse,isspecial,per) VALUES (?,?,?,?,?,?,?,?,0,0)`;

export const SELECT_EQUIP = `SELECT COALESCE(MAX(equipid),0) AS m FROM equip`;

export const SELECT_EQUIP_BY_CHARID = `SELECT slot FROM equip WHERE charid=? AND pos1=0 AND pos2=0`;

export const SELECT_EQUIP_BY_CHARID_10 = `SELECT pos2, soulperc FROM equip WHERE charid=? AND pos1=0 AND FLOOR(type/100000)=85`;

export const SELECT_EQUIP_BY_CHARID_11 = `SELECT type,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse FROM equip WHERE charid=? AND pos1=? AND pos2=? LIMIT 1`;

export const SELECT_EQUIP_BY_CHARID_2 = `SELECT pos2 FROM equip WHERE charid=? AND pos1=?`;

export const SELECT_EQUIP_BY_CHARID_3 = `SELECT * FROM equip WHERE charid=? AND pos1=0 ORDER BY pos2`;

export const SELECT_EQUIP_BY_CHARID_4 = `SELECT * FROM equip WHERE charid=? AND pos1=? ORDER BY pos2`;

export const SELECT_EQUIP_BY_CHARID_5 = `SELECT * FROM equip WHERE charid=? AND pos1=0`;

export const SELECT_EQUIP_BY_CHARID_6 = `SELECT type FROM equip WHERE charid=? AND pos1=? AND pos2=?`;

export const SELECT_EQUIP_BY_CHARID_7 = `SELECT type, pos2 FROM equip WHERE charid = ? AND pos1 = 0`;

export const SELECT_EQUIP_BY_CHARID_8 = `SELECT p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1 FROM equip WHERE charid=? AND pos1=0 AND pos2=0 LIMIT 1`;

export const SELECT_EQUIP_BY_CHARID_9 = `SELECT type,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash FROM equip WHERE charid=? AND pos1=? AND pos2=?`;

export const SELECT_EQUIP_BY_CHARID_AND_TYPE = `SELECT pos1, pos2 FROM equip WHERE charid=? AND type=? ORDER BY pos1, pos2 LIMIT ?`;

export const SELECT_EQUIP_BY_CHARID_AND_TYPE_2 = `SELECT pos2 FROM equip WHERE charid=? AND pos1=? AND type=? ORDER BY pos2 DESC LIMIT 1`;

export function selectEquipByCharIdsIn(ph: string): string {
  return `SELECT charid, type, pos2 FROM equip WHERE pos1 = 0 AND charid IN (${ph})`;
}

export const SELECT_OTHER = `SELECT COALESCE(MAX(otherid),0) AS m FROM other`;

export const SELECT_OTHER_BY_CHARID = `SELECT pos2 FROM other WHERE charid=? AND pos1=4`;

export const SELECT_OTHER_BY_CHARID_2 = `SELECT * FROM other WHERE charid=? AND pos1=4 ORDER BY pos2`;

export const SELECT_OTHER_BY_CHARID_3 = `SELECT type, amount FROM other WHERE charid=? AND pos1=4 AND pos2=?`;

export const SELECT_OTHER_BY_CHARID_4 = `SELECT type, amount, iscash FROM other WHERE charid=? AND pos1=4 AND pos2=?`;

export const SELECT_OTHER_BY_CHARID_5 = `SELECT type, amount, iscash, timeuse FROM other WHERE charid=? AND pos1=4 AND pos2=? LIMIT 1`;

export const SELECT_PETS_BY_CID_AND_TYPE = `SELECT slot AS pos2 FROM pets WHERE cid=? AND type=5`;

export const SELECT_PETS_BY_CID_AND_TYPE_2 = `SELECT * FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1`;

export const SELECT_PETS_BY_CID_AND_TYPE_3 = `SELECT slot, itemId, name, level, hp, mp, exp, iscash FROM pets WHERE cid=? AND type=5`;

export const SELECT_PETS_BY_CID_AND_TYPE_4 = `SELECT itemId FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1`;

export const SELECT_PETS_BY_CID_AND_TYPE_5 = `SELECT itemId, hp, mp FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1`;

export const SELECT_PETS_BY_CID_AND_TYPE_6 = `SELECT id FROM pets WHERE cid=? AND type=? AND slot=?`;

export const SELECT_PETS_BY_CID_AND_TYPE_7 = `SELECT id FROM pets WHERE cid=? AND type=5 AND slot=?`;

export const SELECT_PETS_BY_CID_AND_TYPE_8 = `SELECT id, iscash FROM pets WHERE cid=? AND type=5 AND slot=?`;

export const SELECT_PETS_BY_CID_AND_TYPE_9 = `SELECT id FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1`;

export function selectRowDynamicTable(table: string, col: string): string {
  return `SELECT * FROM ${table} WHERE ${col}=? AND charid=? AND pos1=? AND iscash=?`;
}

export function selectRowDynamicTableCol(table: string, col: string): string {
  return `SELECT pos2, amount FROM ${table} WHERE charid=? AND ${col}=? AND amount>0 ORDER BY pos2`;
}

export const SELECT_SPEND = `SELECT COALESCE(MAX(spendid),0) AS m FROM spend`;

export const SELECT_SPEND_BY_CHARID = `SELECT itemid, amount FROM spend WHERE charid=? AND pos1=3 AND pos2=?`;

export const SELECT_SPEND_BY_CHARID_2 = `SELECT pos2, itemid, amount FROM spend WHERE charid=? AND pos1=3 AND amount>=1 ORDER BY pos2`;

export const SELECT_SPEND_BY_CHARID_3 = `SELECT pos2 FROM spend WHERE charid=? AND pos1=3`;

export const SELECT_SPEND_BY_CHARID_4 = `SELECT * FROM spend WHERE charid=? AND pos1=3 ORDER BY pos2`;

export const SELECT_SPEND_BY_CHARID_5 = `SELECT itemid, amount, iscash FROM spend WHERE charid=? AND pos1=3 AND pos2=?`;

export const SELECT_SPEND_BY_CHARID_6 = `SELECT itemid, amount, iscash, timeuse FROM spend WHERE charid=? AND pos1=3 AND pos2=? LIMIT 1`;

export const UPDATE_EQUIP_BY_CHARID = `UPDATE equip SET slot=? WHERE charid=? AND pos1=0 AND pos2=0`;

export const UPDATE_EQUIP_BY_CHARID_2 = `UPDATE equip SET pos1=22,pos2=22 WHERE pos1=? AND pos2=? AND charid=?`;

export const UPDATE_EQUIP_BY_CHARID_3 = `UPDATE equip SET pos1=?,pos2=? WHERE pos1=? AND pos2=? AND charid=?`;

export const UPDATE_EQUIP_BY_CHARID_4 = `UPDATE equip SET pos1=?,pos2=? WHERE pos1=22 AND pos2=22 AND charid=?`;

export const UPDATE_EQUIP_BY_CHARID_5 = `UPDATE equip SET iscash=0 WHERE charid=? AND pos1=? AND pos2=?`;

export const UPDATE_EQUIP_BY_CHARID_6 = `UPDATE equip SET soulperc=? WHERE charid=? AND pos1=0 AND pos2=?`;

export const UPDATE_EQUIP_BY_CHARID_7 = `UPDATE equip SET p_1=?,p_2=?,p_3=?,p_4=?,p_5=?,p_6=?,p_7=?,p_8=?,p_9=?,p_10=?,soulperc=?
           WHERE charid=? AND pos1=? AND pos2=?`;

export const UPDATE_OTHER_BY_CHARID = `UPDATE other SET amount=? WHERE charid=? AND pos1=4 AND pos2=?`;

export const UPDATE_OTHER_BY_CHARID_2 = `UPDATE other SET pos1=22,pos2=22 WHERE pos1=? AND pos2=? AND charid=?`;

export const UPDATE_OTHER_BY_CHARID_3 = `UPDATE other SET pos1=?,pos2=? WHERE pos1=? AND pos2=? AND charid=?`;

export const UPDATE_OTHER_BY_CHARID_4 = `UPDATE other SET pos1=?,pos2=? WHERE pos1=22 AND pos2=22 AND charid=?`;

export const UPDATE_OTHER_BY_CHARID_5 = `UPDATE other SET iscash=0 WHERE charid=? AND pos1=4 AND pos2=?`;

export const UPDATE_PETS_BY_CID_AND_TYPE = `UPDATE pets SET iscash=0 WHERE cid=? AND type=5 AND slot=?`;

export const UPDATE_PETS_BY_ID = `UPDATE pets SET type=?, slot=? WHERE id=?`;

export const UPDATE_PETS_BY_ID_2 = `UPDATE pets SET type=99, slot=99 WHERE id=?`;

export function updateRowDynamicTable(table: string, col: string): string {
  return `UPDATE ${table} SET amount=? WHERE ${col}=? AND charid=? AND pos1=? AND pos2=?`;
}

export const UPDATE_SPEND_BY_CHARID = `UPDATE spend SET amount=? WHERE charid=? AND pos1=3 AND pos2=?`;

export const UPDATE_SPEND_BY_CHARID_2 = `UPDATE spend SET pos1=22,pos2=22 WHERE pos1=? AND pos2=? AND charid=?`;

export const UPDATE_SPEND_BY_CHARID_3 = `UPDATE spend SET pos1=?,pos2=? WHERE pos1=? AND pos2=? AND charid=?`;

export const UPDATE_SPEND_BY_CHARID_4 = `UPDATE spend SET pos1=?,pos2=? WHERE pos1=22 AND pos2=22 AND charid=?`;

export const UPDATE_SPEND_BY_CHARID_5 = `UPDATE spend SET iscash=0 WHERE charid=? AND pos1=3 AND pos2=?`;
