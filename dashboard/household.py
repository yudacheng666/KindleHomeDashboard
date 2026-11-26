"""Local household content model. No network, scheduler or UI dependencies."""
from contextlib import contextmanager
from datetime import date, timedelta
import json
from hashlib import sha256
import os
import sqlite3
from uuid import uuid4

from .trip_store import TripStore

MEALS = ("breakfast", "lunch", "dinner")
_UNSET = object()


def text(value, limit=200):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError("Invalid text")
    return value.strip()


def day(value):
    if type(value) is date:
        return value.isoformat()
    if not isinstance(value, str):
        raise ValueError("Invalid date")
    result = date.fromisoformat(value).isoformat()
    if result != value:
        raise ValueError("Use YYYY-MM-DD")
    return result


def strings(values, limit=30):
    if not isinstance(values, (tuple, list)) or len(values) > limit:
        raise ValueError("Invalid list")
    return [text(v) for v in values]


class Household:
    """Single private database, explicit dates in household local time.

    Recurring tasks have per-occurrence completion; one-off tasks remain due
    until completed. Menu ingredients are copied only on explicit request.
    No content is sent to external services.
    """
    def __init__(self, directory):
        self.path = TripStore(directory).path.parent / "household.sqlite3"
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        with self.db() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("Unknown household schema")
            seed_catalog = not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dish_categories'").fetchone()
            db.executescript("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    start TEXT NOT NULL, repeat TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS completions (
                    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    occurrence TEXT NOT NULL, PRIMARY KEY(task_id, occurrence));
                CREATE TABLE IF NOT EXISTS completion_history (
                    task_id TEXT NOT NULL, occurrence TEXT NOT NULL,
                    completed_at TEXT, title TEXT, hidden INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(task_id, occurrence),
                    FOREIGN KEY(task_id, occurrence) REFERENCES completions(task_id, occurrence) ON DELETE CASCADE);
                CREATE TABLE IF NOT EXISTS posters (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
                    note TEXT NOT NULL, start TEXT NOT NULL, end TEXT,
                    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
                    enabled INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS dish_categories (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
                CREATE TABLE IF NOT EXISTS dishes (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                    category TEXT NOT NULL REFERENCES dish_categories(id) ON DELETE RESTRICT);
                CREATE TABLE IF NOT EXISTS menus (
                    day TEXT NOT NULL, meal TEXT NOT NULL, dishes TEXT NOT NULL,
                    ingredients TEXT NOT NULL, PRIMARY KEY(day, meal));
                CREATE TABLE IF NOT EXISTS shopping (
                    id TEXT PRIMARY KEY, label TEXT NOT NULL,
                    source TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(source, label));
                CREATE TABLE IF NOT EXISTS display_settings (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    seconds INTEGER NOT NULL, include_week INTEGER NOT NULL,
                    include_shopping INTEGER NOT NULL, autoplay INTEGER NOT NULL);
                INSERT OR IGNORE INTO display_settings VALUES (1,180,0,0,0);
                CREATE TABLE IF NOT EXISTS menu_display_settings (
                    id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, days INTEGER NOT NULL);
                INSERT OR IGNORE INTO menu_display_settings VALUES (1,'week',7);
                PRAGMA user_version=1;
            """)
            if seed_catalog:
                db.executemany("INSERT OR IGNORE INTO dish_categories VALUES (?,?)",
                               [(uuid4().hex, name) for name in ("荤菜","素菜","半荤菜","汤羹","主食","早餐","其他")])
            # Restore a missing reserved category when upgrading an older catalog.
            self._other_category(db)

    @contextmanager
    def db(self):
        conn = sqlite3.connect(self.path, timeout=3)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            with conn:
                yield conn
        finally:
            conn.close()

    def add_task(self, title, start, repeat="once"):
        title, start = text(title), day(start)
        if repeat not in ("once", "daily", "weekly"):
            raise ValueError("Invalid repeat")
        key = uuid4().hex
        with self.db() as db:
            db.execute("INSERT INTO tasks VALUES (?,?,?,?)", (key,title,start,repeat))
        return key

    def rename_task(self, key, title):
        with self.db() as db:
            if db.execute("UPDATE tasks SET title=? WHERE id=?", (text(title),key)).rowcount != 1:
                raise ValueError("Unknown task")

    def edit_task(self, key, title, start, repeat):
        title, start = text(title), day(start)
        if repeat not in ("once", "daily", "weekly"):
            raise ValueError("Invalid repeat")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM tasks WHERE id=?", (key,)).fetchone()
            if old is None:
                raise ValueError("Unknown task")
            if (start, repeat) != (old["start"], old["repeat"]) and db.execute(
                    "SELECT 1 FROM completions WHERE task_id=?", (key,)).fetchone():
                raise ValueError("Schedule change would affect completion history")
            db.execute("UPDATE tasks SET title=?,start=?,repeat=? WHERE id=?",
                       (title, start, repeat, key))

    def delete_task(self, key):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM posters WHERE task_id=?", (key,)).fetchone():
                raise ValueError("Remove linked posters first")
            if db.execute("DELETE FROM tasks WHERE id=?", (key,)).rowcount != 1:
                raise ValueError("Unknown task")

    @staticmethod
    def occurrence(task, on):
        if on < task["start"]:
            return None
        if task["repeat"] == "once":
            return task["start"]
        if task["repeat"] == "daily":
            return on
        if (date.fromisoformat(on)-date.fromisoformat(task["start"])).days % 7 == 0:
            return on
        return None

    def _due(self, db, on):
        result = []
        for task in db.execute("SELECT * FROM tasks ORDER BY start,id"):
            occurrence = self.occurrence(task,on)
            if occurrence and not db.execute(
                "SELECT 1 FROM completions WHERE task_id=? AND occurrence=?",
                (task["id"],occurrence)).fetchone():
                result.append({"id":task["id"],"title":task["title"],"occurrence":occurrence})
        return result

    def _upcoming_tasks(self, db, on, due):
        """One visible occurrence per task; never expand an endless recurrence."""
        result = list(due)
        due_ids = {item["id"] for item in due}
        today = date.fromisoformat(on)
        for task in db.execute("SELECT * FROM tasks ORDER BY start,id"):
            if task["id"] in due_ids:
                continue
            start = date.fromisoformat(task["start"])
            if task["repeat"] == "once":
                # Overdue uncompleted items are already in due.
                if start <= today:
                    continue
                candidate = start
                step = 0
            else:
                candidate = max(start,today)
                step = 1 if task["repeat"] == "daily" else 7
                offset = (-(candidate-start).days) % step
                if (date.max-candidate).days < offset:
                    continue
                candidate += timedelta(days=offset)
            # Normally at most today's completed occurrence is skipped. Also
            # respect existing completion markers from an earlier clock setting.
            while db.execute("SELECT 1 FROM completions WHERE task_id=? AND occurrence=?",
                             (task["id"],candidate.isoformat())).fetchone():
                if not step or (date.max-candidate).days < step:
                    candidate = None
                    break
                candidate += timedelta(days=step)
            if candidate is not None:
                result.append({"id":task["id"],"title":task["title"],"occurrence":candidate.isoformat()})
        return sorted(result,key=lambda item:(item["occurrence"],item["id"]))

    def complete(self, key, on, completed=True, completed_at=None):
        on = day(on)
        if type(completed) is not bool:
            raise ValueError("Invalid completion")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            task = db.execute("SELECT * FROM tasks WHERE id=?",(key,)).fetchone()
            occurrence = self.occurrence(task,on) if task else None
            if not occurrence:
                raise ValueError("Task is not due on this date")
            if completed:
                inserted = db.execute("INSERT OR IGNORE INTO completions VALUES (?,?)",(key,occurrence))
                if inserted.rowcount:
                    db.execute("INSERT INTO completion_history VALUES (?,?,?,?,0)",
                               (key, occurrence, completed_at, task["title"]))
            else:
                db.execute("DELETE FROM completions WHERE task_id=? AND occurrence=?",(key,occurrence))

    def delete_history(self, key, occurrence):
        occurrence = day(occurrence)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            task = db.execute("SELECT * FROM tasks WHERE id=?", (key,)).fetchone()
            completion = db.execute("SELECT 1 FROM completions WHERE task_id=? AND occurrence=?",
                                    (key, occurrence)).fetchone()
            if not task or not completion:
                raise ValueError("Unknown completion")
            if task["repeat"] == "once":
                if db.execute("SELECT 1 FROM posters WHERE task_id=?", (key,)).fetchone():
                    raise ValueError("Remove linked posters first")
                db.execute("DELETE FROM tasks WHERE id=?", (key,))
            else:
                # Keep only the occurrence suppression marker; otherwise deletion
                # would resurrect a completed recurring task on the same date.
                db.execute("INSERT OR REPLACE INTO completion_history VALUES (?,?,NULL,NULL,1)",
                           (key, occurrence))

    def add_poster(self, title, body, start, *, end=None, note="", task_id=None):
        title, start = text(title), day(start)
        # Linked posters take their main text from the task, not a duplicate.
        body = "" if task_id is not None else text(body, 1200)
        end = day(end) if end is not None else None
        if end is not None and end < start:
            raise ValueError("Invalid poster dates")
        if not isinstance(note,str) or len(note)>200:
            raise ValueError("Invalid note")
        key = uuid4().hex
        with self.db() as db:
            if task_id is not None and not db.execute("SELECT 1 FROM tasks WHERE id=?",(task_id,)).fetchone():
                raise ValueError("Unknown linked task")
            db.execute("INSERT INTO posters VALUES (?,?,?,?,?,?,?,1)",
                       (key,title,body,note,start,end,task_id))
        return key

    def edit_poster(self, key, title, body, start, *, end=None, note="", task_id=None):
        title, start = text(title), day(start)
        body = "" if task_id is not None else text(body, 1200)
        end = day(end) if end is not None else None
        if end is not None and end < start:
            raise ValueError("Invalid poster dates")
        if not isinstance(note, str) or len(note) > 200:
            raise ValueError("Invalid note")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if task_id is not None and not db.execute(
                    "SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise ValueError("Unknown linked task")
            if db.execute("UPDATE posters SET title=?,body=?,start=?,end=?,note=?,task_id=? WHERE id=?",
                          (title, body, start, end, note, task_id, key)).rowcount != 1:
                raise ValueError("Unknown poster")

    def delete_poster(self, key):
        with self.db() as db:
            if db.execute("DELETE FROM posters WHERE id=?", (key,)).rowcount != 1:
                raise ValueError("Unknown poster")

    def enable_poster(self, key, enabled):
        if type(enabled) is not bool:
            raise ValueError("Invalid enabled value")
        with self.db() as db:
            if db.execute("UPDATE posters SET enabled=? WHERE id=?",(enabled,key)).rowcount!=1:
                raise ValueError("Unknown poster")

    @staticmethod
    def _other_category(db):
        db.execute("INSERT OR IGNORE INTO dish_categories VALUES (?,?)", (uuid4().hex,"其他"))
        return db.execute("SELECT id FROM dish_categories WHERE name=?", ("其他",)).fetchone()[0]

    @staticmethod
    def _auto_catalog(db, names):
        if names:
            other=Household._other_category(db)
            db.executemany("INSERT OR IGNORE INTO dishes VALUES (?,?,?)",
                           [(uuid4().hex, name, other) for name in names])

    def move_other_dishes(self, keys, category):
        if (not isinstance(keys,list) or not 1 <= len(keys) <= 100
                or any(not isinstance(key,str) or len(key)!=32 for key in keys)
                or len(set(keys))!=len(keys)):
            raise ValueError("Invalid dish selection")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            other=self._other_category(db)
            if category==other or not db.execute("SELECT 1 FROM dish_categories WHERE id=?", (category,)).fetchone():
                raise ValueError("Invalid destination category")
            for key in keys:
                if db.execute("UPDATE dishes SET category=? WHERE id=? AND category=?",
                              (category,key,other)).rowcount!=1:
                    raise ValueError("Dish moved or deleted; reload catalog")

    def add_category(self, name):
        name = text(name, 60)
        key = uuid4().hex
        with self.db() as db:
            try:
                db.execute("INSERT INTO dish_categories VALUES (?,?)", (key, name))
            except sqlite3.IntegrityError as exc:
                raise ValueError("Duplicate category") from exc
        return key

    def edit_category(self, key, name):
        name = text(name, 60)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if key==self._other_category(db):
                raise ValueError("Reserved category")
            try:
                if db.execute("UPDATE dish_categories SET name=? WHERE id=?", (name,key)).rowcount != 1:
                    raise ValueError("Unknown category")
            except sqlite3.IntegrityError as exc:
                raise ValueError("Duplicate category") from exc

    def delete_category(self, key):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if key==self._other_category(db):
                raise ValueError("Reserved category")
            try:
                if db.execute("DELETE FROM dish_categories WHERE id=?", (key,)).rowcount != 1:
                    raise ValueError("Unknown category")
            except sqlite3.IntegrityError as exc:
                raise ValueError("Move dishes before deleting category") from exc

    def add_dish(self, name, category):
        name = text(name)
        key = uuid4().hex
        with self.db() as db:
            try:
                db.execute("INSERT INTO dishes VALUES (?,?,?)", (key,name,category))
            except sqlite3.IntegrityError as exc:
                raise ValueError("Duplicate dish or unknown category") from exc
        return key

    def edit_dish(self, key, name, category):
        name = text(name)
        with self.db() as db:
            try:
                if db.execute("UPDATE dishes SET name=?,category=? WHERE id=?", (name,category,key)).rowcount != 1:
                    raise ValueError("Unknown dish")
            except sqlite3.IntegrityError as exc:
                raise ValueError("Duplicate dish or unknown category") from exc

    def delete_dish(self, key):
        with self.db() as db:
            if db.execute("DELETE FROM dishes WHERE id=?", (key,)).rowcount != 1:
                raise ValueError("Unknown dish")

    def add_dishes(self, names, category):
        names = strings(names)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM dish_categories WHERE id=?", (category,)).fetchone():
                raise ValueError("Unknown category")
            db.executemany("INSERT OR IGNORE INTO dishes VALUES (?,?,?)",
                           [(uuid4().hex, name, category) for name in names])
            return self._catalog(db)

    @staticmethod
    def _catalog(db):
        return {"categories":[dict(r) for r in db.execute("SELECT * FROM dish_categories ORDER BY rowid")],
                "dishes":[dict(r) for r in db.execute("SELECT * FROM dishes ORDER BY name,id")]}

    def set_menu(self, on, meal, dishes, ingredients=()):
        on = day(on)
        if meal not in MEALS:
            raise ValueError("Invalid meal")
        dishes,ingredients = strings(dishes),strings(ingredients,80)
        if not dishes:
            raise ValueError("At least one dish required")
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO menus VALUES (?,?,?,?)",
                       (on,meal,json.dumps(dishes,ensure_ascii=False),json.dumps(ingredients,ensure_ascii=False)))

    @staticmethod
    def _menu_snapshot(db, on, meal):
        current = db.execute("SELECT dishes,ingredients FROM menus WHERE day=? AND meal=?",
                             (on,meal)).fetchone()
        return None if current is None else {k:json.loads(current[k]) for k in ("dishes","ingredients")}

    @staticmethod
    def _check_menu_snapshot(db, on, meal, expected):
        if expected is _UNSET:
            return
        if expected is not None:
            if not isinstance(expected, dict) or set(expected) != {"dishes", "ingredients"}:
                raise ValueError("Invalid expected menu")
            expected = {"dishes": strings(expected["dishes"]),
                        "ingredients": strings(expected["ingredients"],80)}
        if Household._menu_snapshot(db,on,meal) != expected:
            raise ValueError("Menu changed; reload before saving")

    def edit_menu(self, old_on, old_meal, on, meal, dishes, ingredients, expected=_UNSET):
        """Move or edit one menu atomically without overwriting another meal."""
        old_on, on = day(old_on), day(on)
        if old_meal not in MEALS or meal not in MEALS:
            raise ValueError("Invalid meal")
        dishes, ingredients = strings(dishes), strings(ingredients,80)
        if not dishes:
            raise ValueError("At least one dish required")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            self._check_menu_snapshot(db,old_on,old_meal,expected)
            if not db.execute("SELECT 1 FROM menus WHERE day=? AND meal=?",
                              (old_on, old_meal)).fetchone():
                raise ValueError("Unknown menu")
            if (old_on, old_meal) != (on, meal) and db.execute(
                    "SELECT 1 FROM menus WHERE day=? AND meal=?", (on, meal)).fetchone():
                raise ValueError("Target meal already exists")
            original = self._menu_snapshot(db,old_on,old_meal)
            self._auto_catalog(db,[name for name in dishes if name not in original["dishes"]])
            db.execute("UPDATE menus SET day=?,meal=?,dishes=?,ingredients=? WHERE day=? AND meal=?",
                       (on, meal, json.dumps(dishes,ensure_ascii=False),
                        json.dumps(ingredients,ensure_ascii=False), old_on, old_meal))
            # Shopping entries are independent snapshots; preserve labels,
            # sources and completed states just as with menu replacement/deletion.

    def plan_menu(self, on, meal, dishes, ingredients, expected):
        """Save a selected meal only if its current snapshot still matches."""
        on = day(on)
        if meal not in MEALS:
            raise ValueError("Invalid meal")
        dishes, ingredients = strings(dishes), strings(ingredients,80)
        if not dishes:
            raise ValueError("At least one dish required")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            self._check_menu_snapshot(db,on,meal,expected)
            previous = self._menu_snapshot(db,on,meal)
            self._auto_catalog(db,[name for name in dishes if previous is None or name not in previous["dishes"]])
            db.execute("INSERT OR REPLACE INTO menus VALUES (?,?,?,?)",
                       (on,meal,json.dumps(dishes,ensure_ascii=False),json.dumps(ingredients,ensure_ascii=False)))

    def add_manual_menu_dish(self, on, meal, name):
        return self.change_menu_dish(on,meal,name,True,False,None,manual=True)

    def change_menu_dish(self, on, meal, name, present, confirm_empty, expected_ingredients, manual=False):
        """Apply explicit single-dish intent to the current shared meal atomically."""
        on, name = day(on), text(name)
        if meal not in MEALS or type(present) is not bool or type(confirm_empty) is not bool:
            raise ValueError("Invalid meal or operation")
        if confirm_empty:
            if present:
                raise ValueError("Invalid empty confirmation")
            expected_ingredients = strings(expected_ingredients,80)
        elif expected_ingredients is not None:
            raise ValueError("Unexpected ingredients")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = self._menu_snapshot(db,on,meal)
            if current is None and not present:
                return None
            dishes = current["dishes"] if current else []
            ingredients = current["ingredients"] if current else []
            if present:
                if name not in dishes:
                    dishes = dishes + [name]
            elif name in dishes:
                dishes = [dish for dish in dishes if dish != name]
                if not dishes:
                    if not confirm_empty or ingredients != expected_ingredients:
                        raise ValueError("Confirm removal of final dish and ingredients")
                    db.execute("DELETE FROM menus WHERE day=? AND meal=?", (on,meal))
                    return None
            if len(dishes) > 30:
                raise ValueError("Too many dishes")
            if manual:
                self._auto_catalog(db,[name])
            db.execute("INSERT OR REPLACE INTO menus VALUES (?,?,?,?)",
                       (on,meal,json.dumps(dishes,ensure_ascii=False),json.dumps(ingredients,ensure_ascii=False)))
            return {"day":on,"meal":meal,"dishes":dishes,"ingredients":ingredients}

    def delete_menu(self, on, meal, expected=_UNSET):
        on = day(on)
        if meal not in MEALS:
            raise ValueError("Invalid meal")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            self._check_menu_snapshot(db,on,meal,expected)
            if db.execute("DELETE FROM menus WHERE day=? AND meal=?", (on, meal)).rowcount != 1:
                raise ValueError("Unknown menu")

    def _menus(self, db, first, last):
        rows = db.execute("SELECT * FROM menus WHERE day BETWEEN ? AND ? ORDER BY day",(first,last))
        result=[{"day":r["day"],"meal":r["meal"],"dishes":json.loads(r["dishes"]),
                 "ingredients":json.loads(r["ingredients"])} for r in rows]
        return sorted(result,key=lambda r:(r["day"],MEALS.index(r["meal"])))

    def add_shopping(self, label):
        label = text(label)
        with self.db() as db:
            db.execute("INSERT OR IGNORE INTO shopping VALUES (?,?,?,0)",(uuid4().hex,label,"manual"))
            return db.execute("SELECT id FROM shopping WHERE source='manual' AND label=?",(label,)).fetchone()[0]

    def import_ingredients(self, first, last):
        first,last = day(first),day(last)
        if last < first or (date.fromisoformat(last)-date.fromisoformat(first)).days > 6:
            raise ValueError("Select up to seven days")
        added=0
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            for menu in self._menus(db,first,last):
                source="menu:"+menu["day"]+":"+menu["meal"]
                for label in menu["ingredients"]:
                    if db.execute("SELECT 1 FROM shopping WHERE label=? AND source='manual' AND completed=0",(label,)).fetchone():
                        continue
                    added+=db.execute("INSERT OR IGNORE INTO shopping VALUES (?,?,?,0)",(uuid4().hex,label,source)).rowcount
        return added

    def edit_shopping(self, key, label):
        label = text(label)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            item = db.execute("SELECT source FROM shopping WHERE id=?", (key,)).fetchone()
            if item is None:
                raise ValueError("Unknown shopping item")
            if db.execute("SELECT 1 FROM shopping WHERE source=? AND label=? AND id<>?",
                          (item["source"], label, key)).fetchone():
                raise ValueError("Duplicate shopping item")
            db.execute("UPDATE shopping SET label=? WHERE id=?", (label, key))

    def delete_shopping(self, key):
        with self.db() as db:
            if db.execute("DELETE FROM shopping WHERE id=?", (key,)).rowcount != 1:
                raise ValueError("Unknown shopping item")

    @staticmethod
    def _display_settings(db):
        row = db.execute("SELECT * FROM display_settings WHERE id=1").fetchone()
        return {"seconds": row["seconds"], "include_week": bool(row["include_week"]),
                "include_shopping": bool(row["include_shopping"]), "autoplay": bool(row["autoplay"])}

    def set_display_settings(self, seconds, include_week, include_shopping, autoplay):
        if type(seconds) is not int or seconds not in (120, 180, 300):
            raise ValueError("Invalid rotation interval")
        if any(type(v) is not bool for v in (include_week, include_shopping, autoplay)):
            raise ValueError("Invalid display flags")
        with self.db() as db:
            db.execute("UPDATE display_settings SET seconds=?,include_week=?,include_shopping=?,autoplay=? WHERE id=1",
                       (seconds, include_week, include_shopping, autoplay))

    def manage(self, on):
        """Include inactive content for authorized editing, separate from display."""
        on = day(on)
        with self.db() as db:
            db.execute("BEGIN")
            tasks = []
            for row in db.execute("SELECT * FROM tasks ORDER BY start,id"):
                task = dict(row)
                occurrence = self.occurrence(task, on)
                task["occurrence"] = occurrence
                task["completed"] = bool(occurrence and db.execute(
                    "SELECT 1 FROM completions WHERE task_id=? AND occurrence=?",
                    (task["id"], occurrence)).fetchone())
                tasks.append(task)
            history = [dict(r) for r in db.execute("""
                SELECT t.id, COALESCE(h.title,t.title) AS title, t.repeat,
                       c.occurrence, h.completed_at
                FROM completions c JOIN tasks t ON t.id=c.task_id
                LEFT JOIN completion_history h ON h.task_id=c.task_id AND h.occurrence=c.occurrence
                WHERE COALESCE(h.hidden,0)=0
                ORDER BY COALESCE(h.completed_at,c.occurrence) DESC, c.occurrence DESC, t.id
                """)]
            by_id = {task["id"]: task for task in tasks}
            for record in history:
                record["restorable"] = by_id[record["id"]]["occurrence"] == record["occurrence"]
            return {"date": on, "display_settings": self._display_settings(db), "tasks": tasks,
                    "history": history, "catalog": self._catalog(db), "menu_display":self._menu_display(db),
                    "posters": [dict(r) for r in db.execute("SELECT * FROM posters ORDER BY start,id")],
                    "shopping": [dict(r) for r in db.execute("SELECT * FROM shopping ORDER BY completed,id")]}

    @staticmethod
    def _menu_display(db):
        row=db.execute("SELECT mode,days FROM menu_display_settings WHERE id=1").fetchone()
        return dict(row)

    def set_menu_display(self, mode, days):
        if (mode not in ("week","rolling","custom") or type(days) is not int
                or not 1<=days<=31 or (mode in ("week","rolling") and days!=7)):
            raise ValueError("Invalid menu display range")
        with self.db() as db:
            db.execute("UPDATE menu_display_settings SET mode=?,days=? WHERE id=1",(mode,days))

    def sync_menus(self, first, last, catalog_revision):
        first,last=day(first),day(last)
        if last<first or (date.fromisoformat(last)-date.fromisoformat(first)).days>6:
            raise ValueError("Select up to seven days")
        if not isinstance(catalog_revision,str) or len(catalog_revision)>64:
            raise ValueError("Invalid catalog revision")
        with self.db() as db:
            db.execute("BEGIN")
            catalog=self._catalog(db)
            revision=sha256(json.dumps(catalog,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
            result={"menus":self._menus(db,first,last),"catalog_revision":revision}
            if revision!=catalog_revision:
                result["catalog"]=catalog
            return result

    def menus_between(self, first, last):
        first, last = day(first), day(last)
        if last < first or (date.fromisoformat(last)-date.fromisoformat(first)).days > 6:
            raise ValueError("Select up to seven days")
        with self.db() as db:
            return self._menus(db, first, last)

    def complete_shopping(self, key, completed=True):
        if type(completed) is not bool:
            raise ValueError("Invalid completion")
        with self.db() as db:
            if db.execute("UPDATE shopping SET completed=? WHERE id=?",(completed,key)).rowcount!=1:
                raise ValueError("Unknown shopping item")

    def view(self, on):
        on=day(on)
        monday=date.fromisoformat(on)
        monday-=timedelta(days=monday.weekday())
        with self.db() as db:
            db.execute("BEGIN")
            tasks=self._due(db,on)
            due={t["id"]:t["title"] for t in tasks}
            posters=[]
            for p in db.execute("SELECT * FROM posters WHERE enabled=1 AND start<=? AND (end IS NULL OR end>=?) ORDER BY id",(on,on)):
                if p["task_id"] is not None and p["task_id"] not in due:
                    continue
                posters.append({"id":p["id"],"title":p["title"],"body":due[p["task_id"]] if p["task_id"] else p["body"],"note":p["note"],"task_id":p["task_id"]})
            settings=self._menu_display(db)
            first=monday if settings["mode"]=="week" else date.fromisoformat(on)
            last=first+timedelta(days=min(settings["days"]-1,(date.max-first).days))
            week=self._menus(db,first.isoformat(),last.isoformat())
            shopping=[dict(r) for r in db.execute("SELECT * FROM shopping ORDER BY completed,id")]
            return {"date":on,"display_settings":self._display_settings(db),"tasks":tasks,"upcoming_tasks":self._upcoming_tasks(db,on,tasks),"posters":posters,
                    "today_menu":[m for m in week if m["day"]==on],
                    "week_menu":week,"menu_display":settings,"menu_range":{"first":first.isoformat(),"last":last.isoformat()},"shopping":shopping}
