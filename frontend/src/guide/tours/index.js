// Every tour by id. Add a file per tour and a line here.
import firstRun from "./firstRun.js";
import aiChat from "./aiChat.js";

export const TOURS = Object.fromEntries([firstRun, aiChat].map((t) => [t.id, t]));
