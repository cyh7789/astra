-- 記憶穿梭正式版（docs/plans/2026-07-04-memory-traversal.md §4.5 / §4.6 / §4.9）

-- 交接浮現去重：浮現過的記憶不重複嘮叨
ALTER TABLE memories ADD COLUMN surfaced_at TIMESTAMPTZ;

-- 對話工作集持久化：任何終端 resume 即無縫接續（跨終端穿梭）
-- window_entries 只存 memory id + 元資料，內容 resume 時按 id 重抓 memories 表（單一事實來源）
CREATE TABLE session_state (
    user_id UUID PRIMARY KEY,
    context TEXT NOT NULL,
    turn INT NOT NULL DEFAULT 0,
    window_entries JSONB NOT NULL DEFAULT '[]',
    transcript JSONB NOT NULL DEFAULT '[]',
    digest TEXT NOT NULL DEFAULT '',
    open_threads JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
