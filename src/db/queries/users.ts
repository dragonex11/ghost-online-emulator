export const INSERT_USERS = `INSERT INTO users (accountid, username, password, gm, game_points) VALUES (?,?,?,?,?)`;

export const SELECT_USERS = `SELECT COALESCE(MAX(accountid),0) AS m FROM users`;

export const SELECT_USERS_BY_ACCOUNTID = `SELECT game_points, gift_points, bonus_points FROM users WHERE accountid = ?`;

export const SELECT_USERS_BY_ACCOUNTID_2 = `SELECT game_points FROM users WHERE accountid = ?`;

export const SELECT_USERS_BY_ACCOUNTID_3 = `SELECT gm FROM users WHERE accountid = ?`;

export const SELECT_USERS_BY_USERNAME = `SELECT password, accountid FROM users WHERE username = ?`;

export const SELECT_USERS_BY_USERNAME_2 = `SELECT accountid, password, gm FROM users WHERE username = ?`;

export const SELECT_USERS_BY_USERNAME_3 = `SELECT password FROM users WHERE username = ?`;

export const UPDATE_USERS_BY_ACCOUNTID = `UPDATE users SET game_points = game_points - ? WHERE accountid = ?`;
