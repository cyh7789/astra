# ASTRA — Adaptive Spatial-Temporal Recall Agent

跨場景記憶型 AI 夥伴。CockroachDB × AWS Hackathon 參賽作品。

## Dev

    brew install cockroachdb/tap/cockroach
    ./scripts/dev-db.sh          # 啟動本地單節點 CockroachDB
    npm install
    npm run migrate              # 建 schema
    npm run seed                 # 灌三場景 demo 記憶
    npm test

## Demo CLI

    npm run cli -- recall --context driving "今天行程怎麼安排？"
