"""Docker smoke test. All data and access tokens are temporary and fictional."""
import json
import os
from pathlib import Path
from secrets import token_urlsafe
import subprocess
from tempfile import TemporaryDirectory
import time


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, **kwargs).stdout.strip()


def main():
    with TemporaryDirectory() as tmp:
        root=Path(tmp)
        data=root/"state"
        data.mkdir(mode=0o700)
        # Standard GitHub-hosted Linux runner only. Never run this against NAS data.
        run("sudo","chown","10001:10001",str(data))
        envfile=root/"tokens"
        envfile.touch(mode=0o600)
        envfile.write_text("KHD_READ_TOKEN="+token_urlsafe(32)+"\nKHD_ADMIN_TOKEN="+token_urlsafe(32)+"\n")
        env={**os.environ,"KHD_PRIVATE_ENV":str(envfile),"KHD_DATA_DIR":str(data)}
        project="khd-ci-"+token_urlsafe(8).lower().replace("_","a").replace("-","b")
        def compose(*args):
            return run("docker","compose","-p",project,*args,env=env)
        def execute(code):
            return compose("exec","-T","dashboard","python","-c",code)
        def wait():
            for _ in range(40):
                try:
                    if execute("import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/display',timeout=2).status)")=="200":
                        return
                except subprocess.CalledProcessError:
                    pass
                time.sleep(.5)
            raise AssertionError("Container did not become ready")
        def api(code):
            return execute("""import os,json,urllib.request
def request(path,body=None,admin=False):
    token=os.environ['KHD_ADMIN_TOKEN' if admin else 'KHD_READ_TOKEN']
    raw=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request('http://127.0.0.1:8080'+path,data=raw,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=5) as response:
        return json.load(response)
"""+code)
        try:
            compose("up","-d","--build")
            wait()
            cid=compose("ps","-q","dashboard")
            inspect=json.loads(run("docker","inspect",cid))[0]
            cfg=inspect["HostConfig"]
            assert inspect["Config"]["User"]=="10001:10001"
            assert cfg["ReadonlyRootfs"] and not cfg["Privileged"] and "ALL" in cfg["CapDrop"]
            assert not cfg["PortBindings"] and cfg["NetworkMode"]!="host"
            assert cfg["Memory"]==128*1024*1024 and cfg["NanoCpus"]==500000000
            assert cfg["PidsLimit"]==32
            assert execute("import os; print(os.getuid())")=="10001"
            assert api("print(request('/api/bus/view')['snapshot']['status'])")=="disabled"
            api("v=request('/api/home/manage',admin=True); request('/api/home/task/add',{'title':'Synthetic container task','start':v['date'],'repeat':'once'},admin=True)")
            assert api("print(request('/api/home/view')['tasks'][0]['title'])")=="Synthetic container task"
            # Replace the container, not just restart its process.
            compose("stop")
            assert run("docker","inspect","--format","{{.State.ExitCode}}",cid)=="0"
            compose("up","-d","--force-recreate","--no-build")
            wait()
            assert api("print(request('/api/home/view')['tasks'][0]['title'])")=="Synthetic container task"
            cid=compose("ps","-q","dashboard")
            stats=run("docker","stats","--no-stream","--format","{{.MemUsage}} | {{.CPUPerc}}",cid)
            print("Docker smoke PASS: non-root, limits, no published port, graceful stop, recreated container retains data.")
            print("Runner idle sample:",stats)
        finally:
            try:
                compose("down")
            finally:
                run("sudo","chown","-R",str(os.getuid())+":"+str(os.getgid()),str(data))


if __name__=="__main__":
    try:
        main()
    except subprocess.CalledProcessError:
        # Never echo env files, process command lines, Docker inspect or logs.
        raise SystemExit("Container command failed; diagnostic output withheld.")
