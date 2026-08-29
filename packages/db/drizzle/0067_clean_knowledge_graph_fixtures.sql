-- Remove only the integration-test marker rows accidentally created when a
-- graph suite was invoked directly against a non-test database. Source rows
-- and relations cascade from memories; remaining marked entities are derived
-- projections and contain no owner knowledge.
DELETE FROM "memories"
WHERE "content" LIKE 'xtest-kgview-%'
   OR "content_hash" LIKE 'xtest-kgview-%';
--> statement-breakpoint
DELETE FROM "knowledge_graph_entities"
WHERE "canonical_key" LIKE '%xtest-kgview-%';
--> statement-breakpoint
DELETE FROM "agents"
WHERE "email" LIKE 'xtest-kgview-%@example.com';
