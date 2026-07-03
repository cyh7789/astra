-- ASTRA memory core schema
-- 向量索引語法已於 2026-07-03 在 CockroachDB v26.2.3 實測通過：
--   CREATE VECTOR INDEX ... ON memories (user_id, embedding) 前綴欄位過濾式向量搜尋 OK
--   <=> cosine distance OK、免 cluster setting
CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    context TEXT NOT NULL,
    memory_type TEXT NOT NULL CHECK (memory_type IN ('episodic', 'semantic', 'procedural')),
    content TEXT NOT NULL,
    embedding VECTOR(1024) NOT NULL,
    importance FLOAT NOT NULL DEFAULT 0.5,
    privacy_level TEXT NOT NULL DEFAULT 'private' CHECK (privacy_level IN ('private', 'cross-context', 'public')),
    access_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_accessed TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    source_context TEXT,
    INDEX idx_user_context (user_id, context),
    INDEX idx_user_type (user_id, memory_type)
);

CREATE TABLE memory_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES memories(id),
    target_id UUID NOT NULL REFERENCES memories(id),
    relation TEXT NOT NULL CHECK (relation IN ('contradicts', 'updates', 'supports', 'caused_by')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VECTOR INDEX idx_mem_vec ON memories (user_id, embedding);
