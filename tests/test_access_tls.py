"""Private credentials and real verified loopback TLS; no remote calls."""
from http.client import HTTPSConnection, HTTPConnection, RemoteDisconnected
import json
from pathlib import Path
import ssl
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
import unittest

from dashboard.access import create_credentials
from dashboard.http_api import API, LocalServer, tls_context
from dashboard.household import Household
from dashboard.runtime import Runtime
from dashboard.service import BusService
from dashboard.trip_store import SOURCE


class AccessTests(unittest.TestCase):
    def test_credentials_private_distinct_and_no_overwrite(self):
        with TemporaryDirectory() as directory:
            path = Path(directory)/"access.env"
            create_credentials(path)
            original = path.read_bytes()
            values = dict(line.split("=",1) for line in original.decode().splitlines())
            self.assertEqual(set(values), {"KHD_READ_TOKEN","KHD_ADMIN_TOKEN"})
            self.assertNotEqual(values["KHD_READ_TOKEN"],values["KHD_ADMIN_TOKEN"])
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            api = API(None,values["KHD_READ_TOKEN"],values["KHD_ADMIN_TOKEN"])
            self.assertTrue(api.authorized("Bearer "+values["KHD_READ_TOKEN"]))
            self.assertFalse(api.authorized("Bearer "+values["KHD_READ_TOKEN"],admin=True))
            with self.assertRaises(FileExistsError):
                create_credentials(path)
            self.assertEqual(path.read_bytes(),original)
            with self.assertRaises(ValueError):
                create_credentials(SOURCE/"fictional-access.env")

    def test_symlink_does_not_overwrite_target(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            target=root/"target"
            target.write_text("fictional")
            path=root/"access.env"
            path.symlink_to(target)
            with self.assertRaises(FileExistsError):
                create_credentials(path)
            self.assertEqual(target.read_text(),"fictional")


class TLSTests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name)
        self.cert=root/"test.pem"
        self.key=root/"test.key"
        # Ephemeral self-signed test certificate, explicitly trusted only by test.
        subprocess.run(["openssl","req","-x509","-newkey","rsa:2048","-nodes",
                        "-days","1","-subj","/CN=example.invalid",
                        "-addext","subjectAltName=IP:127.0.0.1",
                        "-keyout",str(self.key),"-out",str(self.cert)],
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=15)
        self.key.chmod(0o600)
        credentials=root/"access.env"
        create_credentials(credentials)
        tokens=dict(line.split("=",1) for line in credentials.read_text().splitlines())
        self.reader,self.admin=tokens["KHD_READ_TOKEN"],tokens["KHD_ADMIN_TOKEN"]
        self.home=Household(self.temp.name)
        self.server=LocalServer(API(Runtime(BusService(self.temp.name)),self.reader,self.admin,household=self.home),
                                0,tls=tls_context(self.cert,self.key))
        self.thread=Thread(target=self.server.serve_forever,kwargs={"poll_interval":.01})
        self.thread.start()
        self.addCleanup(self.finish)
        self.client=ssl.create_default_context(cafile=str(self.cert))

    def finish(self):
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.server.server_close()

    def request(self,path,token=None,body=None,extra=None):
        conn=HTTPSConnection("127.0.0.1",self.server.server_port,context=self.client,timeout=5)
        headers={}
        if token is not None:
            headers["Authorization"]="Bearer "+token
        if body is not None:
            headers["Content-Type"]="application/json"
        headers.update(extra or {})
        try:
            conn.request("GET" if body is None else "POST",path,headers=headers,
                         body=None if body is None else json.dumps(body))
            res=conn.getresponse()
            return res.status,res.read(),res.getheader("Cache-Control")
        finally:
            conn.close()

    def test_verified_tls_and_permission(self):
        self.assertEqual(self.server.server_address[0],"127.0.0.1")
        self.assertEqual(self.request("/display")[0],200)
        self.assertEqual(self.request("/api/home/view")[0],401)
        status,body,cache=self.request("/api/home/view",self.reader)
        self.assertEqual((status,cache),(200,"no-store"))
        date=json.loads(body)["date"]
        task={"title":"Fictional TLS task","start":date,"repeat":"once"}
        self.assertEqual(self.request("/api/home/task/add",self.reader,task)[0],401)
        self.assertEqual(self.request("/api/home/task/add",self.admin,task,
                         {"Origin":self.server.expected_origin})[0],200)
        self.assertEqual(len(json.loads(self.request("/api/home/view",self.reader)[1])["tasks"]),1)

    def test_wrong_origin_host_and_plaintext(self):
        for headers in ({"Origin":"http://"+self.server.expected_host},
                        {"Origin":"https://example.invalid"},
                        {"Host":"example.invalid"}):
            self.assertEqual(self.request("/api/home/view",self.reader,extra=headers)[0],403)
        conn=HTTPConnection("127.0.0.1",self.server.server_port,timeout=5)
        try:
            with self.assertRaises((OSError, RemoteDisconnected)):
                conn.request("GET","/display")
                conn.getresponse()
        finally:
            conn.close()

    def test_untrusted_certificate_rejected(self):
        conn=HTTPSConnection("127.0.0.1",self.server.server_port,
                             context=ssl.create_default_context(),timeout=5)
        try:
            with self.assertRaises(ssl.SSLCertVerificationError):
                conn.request("GET","/display")
        finally:
            conn.close()

    def test_wrong_certificate_identity_rejected(self):
        conn=HTTPSConnection("localhost",self.server.server_port,context=self.client,timeout=5)
        try:
            with self.assertRaises(ssl.SSLCertVerificationError):
                conn.request("GET","/display")
        finally:
            conn.close()

    def test_key_permissions(self):
        self.key.chmod(0o644)
        with self.assertRaises(ValueError):
            tls_context(self.cert,self.key)


if __name__=="__main__":
    unittest.main()
