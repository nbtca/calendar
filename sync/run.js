import { syncProjectCalendar } from "./src/sync.js";

const result = await syncProjectCalendar(process.env);
console.log(JSON.stringify(result));
