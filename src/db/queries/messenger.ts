export const DELETE_LETTERS_BY_ID_AND_TO_CHARID = `DELETE FROM letters WHERE id = ? AND to_charid = ?`;

export const DELETE_LETTERS_BY_TO_CHARID = `DELETE FROM letters WHERE to_charid = ? ORDER BY id ASC LIMIT 1`;

export const DELETE_LETTERS_BY_TO_CHARID_2 = `DELETE FROM letters WHERE to_charid = ?`;

export const INSERT_FRIENDS = `INSERT IGNORE INTO friends (charid, friendid) VALUES (?, ?), (?, ?)`;

export const INSERT_LETTERS = `INSERT INTO letters (to_charid, from_name, body, unread) VALUES (?, ?, ?, 1)`;

export const SELECT_FRIENDS_BY_CHARID = `SELECT c.ID AS id, c.name AS name, c.level AS level
     FROM friends f
     JOIN characters c ON c.ID = f.friendid
     WHERE f.charid = ?
     ORDER BY c.name
     LIMIT ?`;

export const SELECT_FRIENDS_BY_CHARID_2 = `SELECT COUNT(*) AS n FROM friends WHERE charid = ?`;

export const SELECT_FRIENDS_BY_CHARID_AND_FRIENDID = `SELECT 1 AS ok FROM friends WHERE charid = ? AND friendid = ? LIMIT 1`;

export const SELECT_LETTERS_BY_TO_CHARID = `SELECT id, from_name, body, sent_at, unread
     FROM letters
     WHERE to_charid = ?
     ORDER BY id DESC
     LIMIT ?`;

export const SELECT_LETTERS_BY_TO_CHARID_2 = `SELECT COUNT(*) AS n FROM letters WHERE to_charid = ?`;

export const SELECT_LETTERS_BY_TO_CHARID_3 = `SELECT from_name FROM letters
     WHERE to_charid = ? AND unread <> 0
     ORDER BY id DESC
     LIMIT 1`;

export const UPDATE_LETTERS_BY_ID_AND_TO_CHARID = `UPDATE letters SET unread = 0 WHERE id = ? AND to_charid = ?`;
