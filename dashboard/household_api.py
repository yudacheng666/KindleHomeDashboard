"""Household API operations; explicit allowlist, local date authority."""
from .household import day

READ = "/api/home/view"
MANAGE = "/api/home/manage"

# Map only fixed operations to explicit methods and required fields.
OPERATIONS = {
    "display/set": ("set_display_settings", ("seconds","include_week","include_shopping","autoplay")),
    "task/add": ("add_task", ("title","start","repeat")),
    "task/edit": ("edit_task", ("key","title","start","repeat")),
    "task/delete": ("delete_task", ("key",)),
    "history/delete": ("delete_history", ("key","occurrence")),
    "task/complete": ("complete", ("key","on","completed")),
    "poster/add": ("add_poster", ("title","body","start","end","note","task_id")),
    "poster/edit": ("edit_poster", ("key","title","body","start","end","note","task_id")),
    "poster/enable": ("enable_poster", ("key","enabled")),
    "poster/delete": ("delete_poster", ("key",)),
    "menu/set": ("set_menu", ("on","meal","dishes","ingredients")),
    "menu/edit": ("edit_menu", ("old_on","old_meal","on","meal","dishes","ingredients")),
    "menu/delete": ("delete_menu", ("on","meal")),
    "menu/list": ("menus_between", ("first","last")),
    "shopping/add": ("add_shopping", ("label",)),
    "shopping/edit": ("edit_shopping", ("key","label")),
    "shopping/delete": ("delete_shopping", ("key",)),
    "shopping/import": ("import_ingredients", ("first","last")),
    "shopping/complete": ("complete_shopping", ("key","completed")),
}
POST_PATHS = {"/api/home/"+name for name in OPERATIONS}


class HouseholdAPI:
    def __init__(self, household, runtime):
        self.home, self.runtime = household, runtime

    def today(self):
        return self.runtime.clock().astimezone(self.runtime.zone).date().isoformat()

    def get(self, path):
        if path == READ:
            return self.home.view(self.today())
        if path == MANAGE:
            return self.home.manage(self.today())
        raise ValueError("Unknown operation")

    def post(self, path, body):
        name = path.removeprefix("/api/home/")
        method, fields = OPERATIONS[name]
        expected = set(fields)
        if name.endswith("/delete"):
            expected.add("confirm")
            if body.get("confirm") is not True:
                raise ValueError("Explicit delete confirmation required")
        if set(body) != expected:
            raise ValueError("Invalid operation fields")
        args = {k:body[k] for k in fields}
        if "key" in args and (not isinstance(args["key"],str) or len(args["key"]) != 32):
            raise ValueError("Invalid item ID")
        if "task_id" in args and args["task_id"] is not None and (
                not isinstance(args["task_id"],str) or len(args["task_id"]) != 32):
            raise ValueError("Invalid task ID")
        if name == "task/complete" and day(args["on"]) != self.today():
            # A stale screen must not complete tomorrow's recurrence.
            raise ValueError("Day changed; refresh before completing")
        if name == "task/complete":
            # Actual completion time comes from the NAS, not the client.
            args["completed_at"] = self.runtime.clock().astimezone(self.runtime.zone).isoformat(timespec="seconds")
        result = getattr(self.home, method)(**args)
        return {"result": result}
