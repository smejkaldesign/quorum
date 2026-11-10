// Background imports, one at a time per source. The renderer gets every change on 'source-job' so a card can show
// progress while the user is elsewhere, and the finished state (counts, failures) stays until the next run.
export function createJobs({ emit = () => {}, now = () => Date.now() } = {}) {
  const jobs = {};
  const publish = (job) => { emit({ ...job, failed: [...job.failed] }); };
  const snapshot = (id) => (jobs[id] ? { ...jobs[id], failed: [...jobs[id].failed] } : null);
  return {
    snapshot,
    all: () => Object.fromEntries(Object.keys(jobs).map((id) => [id, snapshot(id)])),
    running: (id) => jobs[id]?.status === 'running',
    // fn gets progress(patch) and runs to completion; its return value becomes job.result
    run: (id, label, fn) => {
      if (jobs[id]?.status === 'running') return jobs[id].promise;
      const job = { id, label, status: 'running', done: 0, total: null, message: null, error: null, failed: [], result: null, startedAt: now(), finishedAt: null };
      jobs[id] = job;
      publish(job);
      const progress = (patch) => { Object.assign(job, patch); publish(job); };
      job.promise = Promise.resolve()
        .then(() => fn(progress))
        .then((result) => { job.status = 'done'; job.result = result ?? null; job.finishedAt = now(); publish(job); return result; })
        .catch((err) => { job.status = 'failed'; job.error = err?.message ?? String(err); job.finishedAt = now(); publish(job); throw err; });
      return job.promise;
    },
  };
}
