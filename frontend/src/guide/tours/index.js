// Every tour by id. Add a file per tour and a line here.
import firstRun from "./firstRun.js";

export const TOURS = Object.fromEntries([firstRun].map((t) => [t.id, t]));
