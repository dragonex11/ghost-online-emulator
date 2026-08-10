export const CREATE_CHAR_MULTI_STATEMENT = `INSERT INTO characters (ID, name, userid, sex) VALUES (?,?,?,?);
       INSERT INTO equip (equipid, type, charid, pos1, pos2) VALUES
         (?,?,?,0,0),(?,?,?,0,1),(?,?,?,0,5),(?,?,?,0,7),(?,?,?,0,8);
       INSERT INTO skills (charid, skillid, points) VALUES
         (?,?,1),(?,?,1),(?,?,1),(?,?,1)`;

export const DELETE_CHARACTERS_BY_ID = `DELETE FROM characters WHERE ID = ?`;

export const SELECT_CHARACTERS_BY_ID = `SELECT * FROM characters WHERE ID = ?`;

export const SELECT_CHARACTERS_BY_ID_2 = `SELECT exp, mexp, level, st_point, sk_point FROM characters WHERE ID=?`;

export const SELECT_CHARACTERS_BY_ID_3 = `SELECT sk_point FROM characters WHERE ID=?`;

export const SELECT_CHARACTERS_BY_ID_4 = `SELECT name, level FROM characters WHERE ID = ? LIMIT 1`;

export const SELECT_CHARACTERS_BY_NAME = `SELECT ID FROM characters WHERE name = ?`;

export const SELECT_CHARACTERS_BY_NAME_2 = `SELECT ID FROM characters WHERE name=?`;

export const SELECT_CHARACTERS_BY_NAME_3 = `SELECT ID, name, level FROM characters WHERE name = ? LIMIT 1`;

export const SELECT_CHARACTERS_BY_NAME_AND_USERID = `SELECT
         (SELECT COUNT(*) FROM characters WHERE name = ?) AS name_taken,
         (SELECT COALESCE(MAX(ID),0) FROM characters) AS max_id,
         (SELECT COALESCE(MAX(equipid),0) FROM equip) AS max_eid,
         (SELECT COUNT(*) FROM characters WHERE userid = ?) AS char_count`;

export const SELECT_CHARACTERS_BY_USERID = `SELECT ID, name, sex, level, job, job2, job3 FROM characters WHERE userid = ? ORDER BY ID`;

export const SELECT_CHARACTERS_BY_USERID_2 = `SELECT ID FROM characters WHERE userid = ? ORDER BY ID`;

export const SELECT_CHARACTERS_BY_USERID_3 = `SELECT ID, name FROM characters WHERE userid = ? ORDER BY ID`;

export const UPDATE_CHARACTERS_BY_ID = `UPDATE characters SET map=?, region=?, charX=?, charY=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_10 = `UPDATE characters SET money=money+? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_11 = `UPDATE characters SET honor=honor+? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_12 = `UPDATE characters SET exp=?, mexp=?, level=?, st_point=?, sk_point=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_13 = `UPDATE characters SET str=3,dex=3,vit=3,intel=3,st_point=40,job=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_14 = `UPDATE characters SET chp=?, cmp=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_15 = `UPDATE characters SET chp=?, cmp=?, charX=?, charY=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_16 = `UPDATE characters SET chp=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_17 = `UPDATE characters SET st_point=st_point+5, sk_point=sk_point+2 WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_18 = `UPDATE characters SET exp=?, level=?, mexp=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_19 = `UPDATE characters SET map=1, region=1, charX=?, charY=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_2 = `UPDATE characters SET chp=?, cmhp=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_20 = `UPDATE characters SET charX=?, charY=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_21 = `UPDATE characters SET map=?, region=?, charX=?, charY=?, chp=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_22 = `UPDATE characters SET cmp=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_23 = `UPDATE characters SET soul=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_24 = `UPDATE characters SET st_point=st_point-1,
        str=?, dex=?, vit=?, intel=?,
        cmhp=?, cmmp=?, chp=?, cmp=?,
        maxdamphy=?, mindamphy=?, maxdamw=?, mindamw=?, def=?
       WHERE ID=? AND st_point>0`;

export const UPDATE_CHARACTERS_BY_ID_25 = `UPDATE characters SET sk_point=sk_point-1 WHERE ID=? AND sk_point>0`;

export const UPDATE_CHARACTERS_BY_ID_3 = `UPDATE characters SET cmp=?, cmmp=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_4 = `UPDATE characters SET money = ? WHERE ID = ?`;

export const UPDATE_CHARACTERS_BY_ID_5 = `UPDATE characters SET level=?, mexp=?, exp=0, st_point=st_point+?, sk_point=sk_point+? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_6 = `UPDATE characters SET level = ?, mexp = ?, st_point = st_point + 5, sk_point = sk_point + 2 WHERE ID = ?`;

export const UPDATE_CHARACTERS_BY_ID_7 = `UPDATE characters SET job=?, job2=?, job3=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_8 = `UPDATE characters SET job2=?, job3=? WHERE ID=?`;

export const UPDATE_CHARACTERS_BY_ID_9 = `UPDATE characters SET money=? WHERE ID=?`;
