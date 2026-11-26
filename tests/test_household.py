"""Household tests using exclusively fictional local content."""
from datetime import date
from tempfile import TemporaryDirectory
import unittest

from dashboard.household import Household
from dashboard.trip_store import SOURCE


class HouseholdTests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home=Household(self.temp.name)
        self.today="2026-01-05"

    def test_empty_view(self):
        view=self.home.view(self.today)
        for key in ("tasks","posters","today_menu","week_menu","shopping"):
            self.assertEqual(view[key],[])

    def test_unbounded_planning_and_display_range(self):
        for day in ("2026-01-01","2026-01-05","2026-01-11","2026-01-12","2026-02-01","2032-04-09"):
            self.home.add_manual_menu_dish(day,"dinner","Example dish")
        self.assertEqual([m["day"] for m in self.home.view(self.today)["week_menu"]],["2026-01-05","2026-01-11"])
        self.home.set_menu_display("custom",31)
        view=Household(self.temp.name).view(self.today)
        self.assertEqual(view["menu_range"],{"first":self.today,"last":"2026-02-04"})
        self.assertEqual([m["day"] for m in view["week_menu"]],["2026-01-05","2026-01-11","2026-01-12","2026-02-01"])
        self.assertEqual(len(self.home.menus_between("2032-04-09","2032-04-09")),1)
        for mode,days in (("custom",0),("custom",32),("week",8),("rolling",False)):
            with self.assertRaises(ValueError):
                self.home.set_menu_display(mode,days)
        self.home.set_menu_display("rolling",7)
        self.assertEqual(self.home.view("2026-01-06")["menu_range"]["last"],"2026-01-12")

    def test_manual_catalog_and_batch_classification(self):
        from concurrent.futures import ThreadPoolExecutor
        target=self.home.add_category("Example target")
        known=self.home.add_dish("Known dish",target)
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda n:self.home.add_manual_menu_dish(self.today,"dinner",n),[" New dish ","New dish","Known dish"]))
        catalog=self.home.manage(self.today)["catalog"]
        other=next(c["id"] for c in catalog["categories"] if c["name"]=="其他")
        new=next(d for d in catalog["dishes"] if d["name"]=="New dish")
        self.assertEqual(len(catalog["dishes"]),2)
        self.assertEqual(new["category"],other)
        self.assertEqual(next(d["category"] for d in catalog["dishes"] if d["id"]==known),target)
        for op in (lambda:self.home.edit_category(other,"Renamed"),lambda:self.home.delete_category(other)):
            with self.assertRaises(ValueError):op()
        self.home.add_manual_menu_dish(self.today,"lunch","Another dish")
        second=next(d["id"] for d in self.home.manage(self.today)["catalog"]["dishes"] if d["name"]=="Another dish")
        with self.assertRaises(ValueError):
            self.home.move_other_dishes([new["id"],known],target)
        self.assertEqual(next(d["category"] for d in self.home.manage(self.today)["catalog"]["dishes"] if d["id"]==new["id"]),other)
        self.home.move_other_dishes([new["id"],second],target)
        self.assertTrue(all(d["category"]==target for d in self.home.manage(self.today)["catalog"]["dishes"]))
        first=self.home.sync_menus(self.today,self.today,"")
        self.assertIn("catalog",first)
        self.assertNotIn("catalog",self.home.sync_menus(self.today,self.today,first["catalog_revision"]))
        self.home.add_manual_menu_dish("2030-01-01","dinner","Future dish")
        self.assertIn("catalog",self.home.sync_menus(self.today,self.today,first["catalog_revision"]))
        self.assertIn("New dish",self.home.view(self.today)["week_menu"][1]["dishes"])
        self.home.plan_menu(self.today,"breakfast",["Manual form dish"],[],None)
        self.assertIn("Manual form dish",[d["name"] for d in self.home.manage(self.today)["catalog"]["dishes"]])

    def test_shared_dishes_concurrent_and_last_confirmation(self):
        from concurrent.futures import ThreadPoolExecutor
        def add(name):
            return self.home.change_menu_dish(self.today,"dinner",name,True,False,None)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(add,["Example A","Example B","Example A","Example C"]))
        self.assertEqual(set(self.home.view(self.today)["week_menu"][0]["dishes"]),{"Example A","Example B","Example C"})
        self.assertEqual(len(self.home.view(self.today)["week_menu"][0]["dishes"]),3)
        self.home.change_menu_dish(self.today,"lunch","Example A",True,False,None)
        for name in ("Example A","Example B"):
            self.home.change_menu_dish(self.today,"dinner",name,False,False,None)
        with self.assertRaises(ValueError):
            self.home.change_menu_dish(self.today,"dinner","Example C",False,False,None)
        self.home.plan_menu(self.today,"dinner",["Example C"],["Example ingredient"],{"dishes":["Example C"],"ingredients":[]})
        with self.assertRaises(ValueError):
            self.home.change_menu_dish(self.today,"dinner","Example C",False,True,[])
        self.assertIsNone(self.home.change_menu_dish(self.today,"dinner","Example C",False,True,["Example ingredient"]))
        self.assertIsNone(self.home.change_menu_dish(self.today,"dinner","Example C",False,False,None))
        self.assertEqual(self.home.view(self.today)["week_menu"][0]["meal"],"lunch")
        self.assertEqual(len(self.home.view(self.today)["week_menu"]),1)

    def test_old_menu_editor_snapshot_guards(self):
        self.home.set_menu(self.today,"dinner",["Example A"])
        original={"dishes":["Example A"],"ingredients":[]}
        self.home.change_menu_dish(self.today,"dinner","Example B",True,False,None)
        with self.assertRaises(ValueError):
            self.home.edit_menu(self.today,"dinner",self.today,"lunch",["Example A"],[],original)
        with self.assertRaises(ValueError):
            self.home.delete_menu(self.today,"dinner",original)
        self.assertEqual(self.home.view(self.today)["week_menu"][0]["dishes"],["Example A","Example B"])

    def test_quick_menu_rejects_stale_snapshot(self):
        self.home.plan_menu(self.today,"dinner",["Example dish"],[],None)
        with self.assertRaises(ValueError):
            self.home.plan_menu(self.today,"dinner",["Another dish"],[],None)
        with self.assertRaises(ValueError):
            self.home.plan_menu(self.today,"dinner",["Another dish"],[],{"dishes":["Wrong"],"ingredients":[]})
        self.assertEqual(self.home.view(self.today)["week_menu"][0]["dishes"],["Example dish"])
        self.home.plan_menu(self.today,"dinner",["Another dish"],[],{"dishes":["Example dish"],"ingredients":[]})
        self.assertEqual(self.home.view(self.today)["week_menu"][0]["dishes"],["Another dish"])

    def test_catalog_crud_preserves_menu_snapshot(self):
        c = self.home.add_category("Example category")
        d = self.home.add_dish("Example dish", c)
        self.home.set_menu(self.today,"dinner",["Example dish"],["Example ingredient"])
        with self.assertRaises(ValueError):
            self.home.add_dish("Example dish",c)
        with self.assertRaises(ValueError):
            self.home.delete_category(c)
        with self.assertRaises(ValueError):
            self.home.edit_dish(d,"Example dish","missing")
        other = self.home.add_category("Another category")
        self.home.edit_dish(d,"Revised dish",other)
        self.home.edit_category(other,"Revised category")
        self.home.delete_category(c)
        self.home.add_dishes(["Example import","Example import","Revised dish"],other)
        self.assertEqual(len(self.home.manage(self.today)["catalog"]["dishes"]),2)
        self.home.delete_dish(d)
        reopened=Household(self.temp.name)
        self.assertEqual(reopened.manage(self.today)["catalog"]["dishes"][0]["name"],"Example import")
        self.assertEqual(reopened.view(self.today)["week_menu"][0]["dishes"],["Example dish"])
        self.assertNotIn("catalog",reopened.view(self.today))

    def test_private_directory_and_file(self):
        with self.assertRaises(ValueError):
            Household(SOURCE)
        self.assertEqual(self.home.path.stat().st_mode & 0o777,0o600)

    def test_once_overdue_and_completion(self):
        key=self.home.add_task("Example task",self.today)
        self.assertEqual(self.home.view("2026-01-04")["tasks"],[])
        self.assertEqual(self.home.view("2026-01-06")["tasks"][0]["occurrence"],self.today)
        self.home.complete(key,"2026-01-06")
        self.assertEqual(self.home.view("2026-01-07")["tasks"],[])
        self.home.complete(key,"2026-01-07",False)
        self.assertEqual(len(self.home.view("2026-01-07")["tasks"]),1)

    def test_history_delete_and_restore(self):
        key=self.home.add_task("Example daily",self.today,"daily")
        stamp="2026-01-05T09:30:00+00:00"
        self.home.complete(key,self.today,completed_at=stamp)
        self.home.complete(key,self.today,completed_at="2026-01-05T10:30:00+00:00")
        record=self.home.manage(self.today)["history"][0]
        self.assertEqual(record["completed_at"],stamp)
        self.assertTrue(record["restorable"])
        self.home.delete_history(key,self.today)
        self.assertEqual(self.home.manage(self.today)["history"],[])
        self.assertEqual(self.home.view(self.today)["tasks"],[])
        self.assertEqual(len(self.home.view("2026-01-06")["tasks"]),1)
        once=self.home.add_task("Example once",self.today)
        self.home.complete(once,"2026-01-06",completed_at=stamp)
        self.assertTrue(self.home.manage("2026-01-07")["history"][0]["restorable"])
        self.home.complete(once,"2026-01-07",False)
        self.assertEqual(self.home.manage("2026-01-07")["history"],[])
        self.home.complete(once,"2026-01-07")
        self.home.delete_history(once,self.today)
        self.assertNotIn(once,[t["id"] for t in self.home.manage(self.today)["tasks"]])

    def test_legacy_completion_has_unknown_timestamp(self):
        key=self.home.add_task("Example legacy",self.today)
        with self.home.db() as db:
            db.execute("INSERT INTO completions VALUES (?,?)",(key,self.today))
        self.assertIsNone(self.home.manage(self.today)["history"][0]["completed_at"])
        self.assertEqual(self.home.view(self.today)["tasks"],[])

    def test_daily_completion_is_per_day(self):
        key=self.home.add_task("Example daily",self.today,"daily")
        self.home.complete(key,self.today)
        self.assertEqual(self.home.view(self.today)["tasks"],[])
        self.assertEqual(len(self.home.view("2026-01-06")["tasks"]),1)
        self.home.complete(key,self.today)
        self.assertEqual(len(self.home.view("2026-01-06")["tasks"]),1)

    def test_weekly_and_wrong_occurrence(self):
        key=self.home.add_task("Example weekly",self.today,"weekly")
        self.assertEqual(self.home.view("2026-01-06")["tasks"],[])
        with self.assertRaises(ValueError):
            self.home.complete(key,"2026-01-06")
        self.home.complete(key,self.today)
        self.assertEqual(len(self.home.view("2026-01-12")["tasks"]),1)

    def test_linked_poster_tracks_task_without_duplication(self):
        key=self.home.add_task("First title",self.today,"daily")
        self.home.add_poster("Reminder",None,self.today,task_id=key)
        self.assertEqual(self.home.view(self.today)["posters"][0]["body"],"First title")
        self.home.rename_task(key,"Revised title")
        self.assertEqual(self.home.view(self.today)["posters"][0]["body"],"Revised title")
        self.home.complete(key,self.today)
        self.assertEqual(self.home.view(self.today)["posters"],[])
        self.assertEqual(self.home.view("2026-01-06")["posters"][0]["body"],"Revised title")

    def test_standalone_poster_dates_and_enable(self):
        key=self.home.add_poster("Example","Line one\nLine two",self.today,end="2026-01-06")
        self.assertEqual(self.home.view("2026-01-04")["posters"],[])
        self.assertEqual(len(self.home.view(self.today)["posters"]),1)
        self.assertEqual(len(self.home.view("2026-01-06")["posters"]),1)
        self.assertEqual(self.home.view("2026-01-07")["posters"],[])
        self.home.enable_poster(key,False)
        self.assertEqual(self.home.view(self.today)["posters"],[])

    def test_menu_day_and_week_boundaries(self):
        for d in ("2026-01-04",self.today,"2026-01-11","2026-01-12"):
            self.home.set_menu(d,"dinner",["Example dish"])
        self.home.set_menu(self.today,"breakfast",["Example breakfast"])
        v=self.home.view(date.fromisoformat(self.today))
        self.assertEqual([m["meal"] for m in v["today_menu"]],["breakfast","dinner"])
        self.assertEqual([m["day"] for m in v["week_menu"]],[self.today,self.today,"2026-01-11"])

    def test_move_menu_preserves_purchases_and_rejects_conflicts(self):
        other = "2026-01-06"
        self.home.set_menu(self.today,"lunch",["Example dish"],["Example ingredient"])
        self.home.import_ingredients(self.today,self.today)
        item = self.home.view(self.today)["shopping"][0]
        self.home.complete_shopping(item["id"])
        self.home.set_menu(other,"breakfast",["Other dish"])
        before = self.home.menus_between(self.today,other)
        with self.assertRaises(ValueError):
            self.home.edit_menu(self.today,"lunch",other,"breakfast",["Example dish"],[])
        self.assertEqual(self.home.menus_between(self.today,other),before)
        self.home.edit_menu(self.today,"lunch",other,"dinner",["Changed dish"],["Example ingredient"])
        self.assertEqual(self.home.view(self.today)["today_menu"],[])
        moved = self.home.view(other)["today_menu"]
        self.assertEqual([(m["meal"],m["dishes"]) for m in moved],
                         [("breakfast",["Other dish"]),("dinner",["Changed dish"])])
        self.home.edit_menu(other,"dinner",other,"dinner",["Edited dish"],[])
        self.assertEqual(self.home.view(other)["today_menu"][1]["dishes"],["Edited dish"])
        self.assertEqual(self.home.view(other)["shopping"],[{**item,"completed":1}])
        with self.assertRaises(ValueError):
            self.home.edit_menu(self.today,"lunch",other,"lunch",["Missing"],[])
        with self.assertRaises(ValueError):
            self.home.edit_menu(other,"dinner",self.today,"lunch",[],[])
        self.assertEqual(self.home.view(other)["today_menu"][1]["dishes"],["Edited dish"])

    def test_explicit_import_and_preserve_completed(self):
        manual=self.home.add_shopping("Example manual")
        self.home.set_menu(self.today,"dinner",["Example dish"],["Example ingredient"])
        self.assertEqual(len(self.home.view(self.today)["shopping"]),1)
        self.assertEqual(self.home.import_ingredients(self.today,self.today),1)
        self.assertEqual(self.home.import_ingredients(self.today,self.today),0)
        ingredient=next(i["id"] for i in self.home.view(self.today)["shopping"] if i["source"]!="manual")
        self.home.complete_shopping(ingredient)
        self.home.set_menu(self.today,"dinner",["New dish"],["New ingredient"])
        self.assertEqual(self.home.import_ingredients(self.today,self.today),1)
        v={i["id"]:i for i in self.home.view(self.today)["shopping"]}
        self.assertIn(manual,v)
        self.assertEqual(v[ingredient]["completed"],1)
        self.assertEqual(len(v),3)

    def test_manual_duplicate_and_import(self):
        a=self.home.add_shopping("Example ingredient")
        self.assertEqual(a,self.home.add_shopping("Example ingredient"))
        self.home.set_menu(self.today,"lunch",["Example dish"],["Example ingredient"])
        self.assertEqual(self.home.import_ingredients(self.today,self.today),0)
        self.assertEqual(len(self.home.view(self.today)["shopping"]),1)

    def test_restart_preserves_all_content(self):
        key=self.home.add_task("Example task",self.today)
        self.home.add_poster("Reminder",None,self.today,task_id=key)
        self.home.set_menu(self.today,"dinner",["Example dish"],["Example ingredient"])
        self.home.import_ingredients(self.today,self.today)
        self.assertEqual(Household(self.temp.name).view(self.today),self.home.view(self.today))

    def test_reject_invalid_inputs_without_changes(self):
        for fn in (
            lambda:self.home.add_task("",self.today),
            lambda:self.home.add_task("Example","2026-02-30"),
            lambda:self.home.add_task("Example",self.today,"invalid"),
            lambda:self.home.add_poster("Example","Body",self.today,end="2026-01-01"),
            lambda:self.home.add_poster("Example",None,self.today,task_id="missing"),
            lambda:self.home.set_menu(self.today,"invalid",["Example"]),
            lambda:self.home.set_menu(self.today,"dinner",[]),
            lambda:self.home.import_ingredients(self.today,"2026-01-20"),
        ):
            with self.assertRaises(ValueError):
                fn()
        self.assertEqual(self.home.view(self.today)["tasks"],[])
        self.assertEqual(self.home.view(self.today)["posters"],[])
        self.assertEqual(self.home.view(self.today)["shopping"],[])


if __name__=="__main__":
    unittest.main()
