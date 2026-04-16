-- Seed an API key for e2e testing
-- Raw key: grn_e2e_test_key_00000000
-- SHA-256 hash of the raw key
-- Key prefix: grn_e2e_
INSERT OR IGNORE INTO api_keys (id, label, key_hash, key_prefix, created_at)
VALUES (
  '01TESTKEY000000000000000000',
  'e2e-test',
  'e2e_hash_placeholder',
  'grn_e2e_',
  unixepoch()
);
