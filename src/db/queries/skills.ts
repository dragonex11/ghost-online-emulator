export const DELETE_SKILLS_BY_CHARID = `DELETE FROM skills WHERE charid = ?`;

export const DELETE_SKILLS_BY_CHARID_2 = `DELETE FROM skills WHERE charid=? AND skillid>=10000`;

export const DELETE_SKILLS_BY_CHARID_3 = `DELETE FROM skills WHERE charid=? AND skillid>=20000`;

export const DELETE_SKILLS_BY_CHARID_4 = `DELETE FROM skills WHERE charid=? AND skillid>=30000`;

export const DELETE_SKILLS_BY_ID = `DELETE FROM skills WHERE id=?`;

export const INSERT_SKILLS = `INSERT INTO skills (charid, skillid, points) VALUES (?,?,1)`;

export const INSERT_SKILLS_BY_CHARID_AND_SKILLID = `INSERT INTO skills (charid, skillid, points)
     SELECT ?, sid, 1 FROM (
       SELECT 1 AS sid UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     ) s
     WHERE NOT EXISTS (
       SELECT 1 FROM skills x WHERE x.charid = ? AND x.skillid = s.sid
     )`;

export const SELECT_SKILLS_BY_CHARID = `SELECT id, skillid FROM skills WHERE charid=?`;

export const SELECT_SKILLS_BY_CHARID_2 = `SELECT id, skillid FROM skills WHERE charid=? AND skillid>=10000 AND skillid<20000`;

export const SELECT_SKILLS_BY_CHARID_3 = `SELECT id, skillid, points FROM skills WHERE charid = ? ORDER BY skillid`;

export const SELECT_SKILLS_BY_CHARID_AND_SKILLID = `SELECT id FROM skills WHERE charid=? AND skillid=?`;

export const UPDATE_SKILLS_BY_ID = `UPDATE skills SET points=? WHERE id=?`;
