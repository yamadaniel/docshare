-- 文書作成の全体上限（1 分ごとの作成数）
CREATE TABLE IF NOT EXISTS create_quota (
  minute INTEGER PRIMARY KEY,
  count INTEGER NOT NULL
);
