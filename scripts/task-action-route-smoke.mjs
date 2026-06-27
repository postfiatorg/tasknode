import assert from "node:assert/strict";

import {
  captureTaskActionRoute,
  restoreTaskActionRoute,
  shouldRestoreTaskActionRoute,
} from "../src/features/tasks/task-action-route.js";

function fakeWindow(initialRoute = "/") {
  const win = {
    location: {},
    history: {
      state: { existing: true },
      replaceState(state, _title, route) {
        this.state = state;
        this.replacedWith = route;
        applyRoute(route);
      },
    },
  };

  function applyRoute(route) {
    const url = new URL(route, "https://tasknode.test");
    win.location.pathname = url.pathname;
    win.location.search = url.search;
    win.location.hash = url.hash;
  }

  applyRoute(initialRoute);
  return win;
}

const hiveWindow = fakeWindow("/#hive");
const hiveSnapshot = captureTaskActionRoute(hiveWindow);
assert.equal(hiveSnapshot.route, "/#hive");

hiveWindow.location.pathname = "/onboarding/auth";
hiveWindow.location.hash = "";
assert.equal(shouldRestoreTaskActionRoute(hiveSnapshot, hiveWindow), true);
assert.equal(restoreTaskActionRoute(hiveSnapshot, hiveWindow), true);
assert.equal(hiveWindow.history.replacedWith, "/#hive");
assert.equal(hiveWindow.location.hash, "#hive");
assert.equal(hiveWindow.history.state.tasknodeTaskActionRouteRestored, true);

const unchangedWindow = fakeWindow("/#tasks/task_1");
const unchangedSnapshot = captureTaskActionRoute(unchangedWindow);
assert.equal(shouldRestoreTaskActionRoute(unchangedSnapshot, unchangedWindow), false);
assert.equal(restoreTaskActionRoute(unchangedSnapshot, unchangedWindow), false);

const userNavigationWindow = fakeWindow("/#tasks/task_1");
const userNavigationSnapshot = captureTaskActionRoute(userNavigationWindow);
userNavigationWindow.location.hash = "#wallet";
assert.equal(
  shouldRestoreTaskActionRoute(userNavigationSnapshot, userNavigationWindow),
  false,
  "intentional in-app hash navigation must not be overwritten"
);

const lostHashWindow = fakeWindow("/#tasks/task_2");
const lostHashSnapshot = captureTaskActionRoute(lostHashWindow);
lostHashWindow.location.pathname = "/unexpected";
lostHashWindow.location.hash = "";
assert.equal(shouldRestoreTaskActionRoute(lostHashSnapshot, lostHashWindow), true);

console.log("task-action-route-smoke ok");
