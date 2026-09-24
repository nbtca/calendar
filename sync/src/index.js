import { syncProjectCalendar } from "./sync.js";

export default {
  async scheduled(_controller, env) {
    const result = await syncProjectCalendar(env);
    console.log(JSON.stringify(result));
  },
};
