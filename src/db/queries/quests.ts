export const DELETE_QUESTS_BY_CHARID_AND_QUESTID = `DELETE FROM quests WHERE charid=? AND questid=?`;

export const INSERT_QUESTS = `INSERT INTO quests (charid, questid, state, progress) VALUES (?,?,49,0)`;

export const UPDATE_QUESTS_BY_CHARID_AND_QUESTID = `UPDATE quests SET state=50 WHERE charid=? AND questid=?`;

export const UPDATE_QUESTS_BY_CHARID_AND_QUESTID_2 = `UPDATE quests SET progress=? WHERE charid=? AND questid=? AND state=49`;

export const UPDATE_QUESTS_BY_ID = `UPDATE quests SET state=49, progress=0 WHERE id=?`;

export const UPDATE_QUESTS_BY_ID_2 = `UPDATE quests SET progress=? WHERE id=?`;
