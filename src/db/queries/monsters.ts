export const SELECT_MONSTER = `SELECT monsterid, map, region, monsterX, monsterY, m_monsterid, health, speed, side FROM monster ORDER BY map, region, m_monsterid`;

export const SELECT_QUESTS_BY_CHARID = `SELECT questid AS questId, state AS questState, progress AS completeMonster FROM quests WHERE charid=? ORDER BY state, id`;

export const SELECT_QUESTS_BY_CHARID_AND_QUESTID = `SELECT id, questid AS questId, state AS questState, progress AS completeMonster FROM quests WHERE charid=? AND questid=? LIMIT 1`;

export const SELECT_QUESTS_BY_CHARID_AND_STATE = `SELECT id, questid AS questId, progress AS completeMonster, state AS questState FROM quests WHERE charid=? AND state=49`;
