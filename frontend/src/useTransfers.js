// Background tasks: client-side transfers (downloads/uploads) plus server-side
// work (library indexing), shown in one popover. App.jsx holds the PDF-load
// handler and the polling effect that feed this state (they're tangled with the
// scroll-restore machinery and the popover-open state); this hook owns the rows.
import { useRef, useState } from "react";

import { makeId } from "./utils";

export function useTransfers() {
  const [transfers, setTransfers] = useState([]); // [{id, name, kind, status, info}]
  const [indexTask, setIndexTask] = useState(null); // {total, done, active} from /api/tasks
  // The server remembers the last run's progress forever; this hides the
  // finished row after "Clear" until a new indexing run starts.
  const [indexTaskCleared, setIndexTaskCleared] = useState(false);
  const transferByUrlRef = useRef({});

  function addTransfer(t) {
    const id = makeId();
    setTransfers((prev) => [{ id, status: "active", ...t }, ...prev].slice(0, 20));
    return id;
  }
  function updateTransfer(id, patch) {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  return {
    transfers,
    setTransfers,
    indexTask,
    setIndexTask,
    indexTaskCleared,
    setIndexTaskCleared,
    transferByUrlRef,
    addTransfer,
    updateTransfer,
  };
}
