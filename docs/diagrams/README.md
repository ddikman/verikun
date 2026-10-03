# Server supervision

The parent server owns health, streaming leases, FIFO admission and the retained build. Each device has one detached executor process group; device-tool children run in that group. The client compiles before acquiring a lease.

![Server supervisor and isolated executors](server-supervision.png)

# Device loss and recovery

Typed loss ends the current lease, even when the confirming probe succeeds. A suite reruns the whole test on a healthy sibling without spending a retry, at most twice per test. The failed action is never replayed elsewhere.

Confirmed device failure kills the executor process group. A four-minute install deadline also kills that group directly. A client soft deadline alone lets the original call drain. Re-adoption waits for actual exit and companion cleanup, then restores settings and verifies the retained build before dealing.

![Device loss, independent rerun and readmission](server-recovery.png)

Edit [server-supervision.d2](server-supervision.d2) or [server-recovery.d2](server-recovery.d2), then render with `d2 source.d2 output.png`. Both import the shared [_style.d2](_style.d2).
