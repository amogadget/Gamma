"""The NDJSON keepalive wrapper on the AI streams: ping lines in silent gaps,
the source's exception relayed, and a consumer that leaves early stopping the
source at its next yield."""

import json
import threading
import time

from gamma.routers.ai import keepalive_lines


def test_pings_fill_silent_gaps():
    def slow():
        yield '{"delta": "a"}\n'
        time.sleep(0.25)
        yield '{"delta": "b"}\n'

    lines = list(keepalive_lines(slow(), "t", interval=0.05))
    events = [json.loads(l) for l in lines]
    assert [e for e in events if "delta" in e] == [{"delta": "a"}, {"delta": "b"}]
    pings = [e for e in events if "ping" in e]
    assert pings and events[0] == {"delta": "a"} and events[-1] == {"delta": "b"}
    assert all(e == {"ping": 1} for e in pings)


def test_no_pings_when_source_is_quick():
    def quick():
        for i in range(5):
            yield f'{{"delta": "{i}"}}\n'

    lines = list(keepalive_lines(quick(), "t", interval=1))
    assert len(lines) == 5 and all("ping" not in l for l in lines)


def test_source_error_is_relayed():
    def broken():
        yield '{"delta": "x"}\n'
        raise RuntimeError("upstream died")

    gen = keepalive_lines(broken(), "t", interval=1)
    assert next(gen) == '{"delta": "x"}\n'
    try:
        next(gen)
    except RuntimeError as e:
        assert "upstream died" in str(e)
    else:
        raise AssertionError("source error not relayed")


def test_abandoned_consumer_stops_the_source():
    """Closing the wrapper (what Starlette does when the client goes away)
    stops the source at its next yield — no more provider rounds after the
    Stop button or a dropped connection."""
    closed = threading.Event()
    produced = []

    def source():
        try:
            for i in range(100):
                produced.append(i)
                yield f'{{"delta": "{i}"}}\n'
                time.sleep(0.01)
        finally:
            closed.set()

    gen = keepalive_lines(source(), "t", interval=1)
    assert next(gen) == '{"delta": "0"}\n'
    gen.close()
    assert closed.wait(2), "source generator was not closed"
    assert len(produced) < 100
