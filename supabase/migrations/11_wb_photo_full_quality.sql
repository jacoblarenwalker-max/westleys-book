-- Westley's Book: keep original photo quality. Raise the per-file cap on the private wb-photos bucket from
-- 5 MB to 20 MB (still JPEG only, still private). Nothing else changes.
update storage.buckets set file_size_limit = 20971520 where id = 'wb-photos';
