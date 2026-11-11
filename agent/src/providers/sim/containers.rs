//! Containers.
//!
//! Six of them, with the mix a small fleet actually has: a few things that
//! stay up, one that exited non-zero and one that was created and never
//! started. State changes stick and push container.changed, and
//! `container.exec` drops into the same fake shell the terminal uses,
//! rooted in the container's own tiny filesystem rather than the host's.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::files::{self, FsRef};
use super::logs::{self, TailRequest};
use super::pty::PtySession;
use super::services::{bring_down, bring_up, find_unit};
use super::state::{GIB, MIB, Sim, World, clampf, drift, hash_string, human_duration, mix, round2, stamp};
use crate::providers::{
    ContainerExecParams, ContainerInfo, ContainerInspectResult, ContainerListParams, ContainerLogsParams,
    ContainerMount, ContainerPort, ContainerPruneParams, ContainerPruneResult, ContainerRemoveParams,
    ContainerStopParams, Containers, Ctx, ImageInfo, ImagePullParams, ImagePullResult, LogRecord,
    ManagedAppRemoveParams, ManagedAppRemoveResult, ManagedAppStatus, ManagedContainerSpec,
    ManagedContainerState, ManagedEndpoint, ManagedNetworkResult, ManagedTaskParams, ManagedTaskResult, PResult, ProviderError, StreamRef, managed,
    say, topic,
};

pub struct Container {
    pub info: ContainerInfo,
    pub process: String,
    pub process_args: String,
    pub process_user: String,
    pub rss_base: i64,
    pub mem_limit: i64,
    pub cpu_base: f64,
    pub fs: Option<FsRef>,
}

struct ContainerSeed {
    name: &'static str,
    image: &'static str,
    state: &'static str,
    age_days: i64,
    ports: Vec<ContainerPort>,
    labels: Vec<(&'static str, &'static str)>,
    networks: Vec<&'static str>,
    mounts: Vec<ContainerMount>,
    process: &'static str,
    process_args: &'static str,
    process_user: &'static str,
    rss: i64,
    mem_limit: i64,
    cpu: f64,
    exit_code: i64,
    restarts: i64,
}

fn tcp(host: i64, guest: i64) -> ContainerPort {
    ContainerPort {
        container_port: guest,
        host_port: Some(host),
        host_ip: Some("0.0.0.0".into()),
        protocol: "tcp".into(),
    }
}

fn mount(source: &str, destination: &str, rw: bool) -> ContainerMount {
    ContainerMount {
        source: source.into(),
        destination: destination.into(),
        rw,
    }
}

fn catalogue() -> Vec<ContainerSeed> {
    vec![
        ContainerSeed {
            name: "kaname-redis",
            image: "redis:7-alpine",
            state: "running",
            age_days: 41,
            ports: vec![tcp(6379, 6379)],
            labels: vec![
                ("com.docker.compose.project", "kaname"),
                ("com.docker.compose.service", "redis"),
            ],
            networks: vec!["kaname_default"],
            mounts: vec![mount("/var/lib/docker/volumes/kaname_redis/_data", "/data", true)],
            process: "redis-server",
            process_args: "redis-server *:6379",
            process_user: "systemd-network",
            rss: 38 * MIB,
            mem_limit: 512 * MIB,
            cpu: 0.9,
            exit_code: 0,
            restarts: 0,
        },
        ContainerSeed {
            name: "kaname-minio",
            image: "minio/minio:RELEASE.2024-06-13T22-53-53Z",
            state: "running",
            age_days: 41,
            ports: vec![tcp(9000, 9000), tcp(9001, 9001)],
            labels: vec![
                ("com.docker.compose.project", "kaname"),
                ("com.docker.compose.service", "minio"),
            ],
            networks: vec!["kaname_default"],
            mounts: vec![mount("/srv/minio", "/data", true)],
            process: "minio",
            process_args: "minio server /data --console-address :9001",
            process_user: "root",
            rss: 214 * MIB,
            mem_limit: 2 * GIB,
            cpu: 2.4,
            exit_code: 0,
            restarts: 0,
        },
        ContainerSeed {
            name: "pgbouncer",
            image: "edoburu/pgbouncer:1.22.1",
            state: "running",
            age_days: 26,
            ports: vec![tcp(6432, 5432)],
            labels: vec![
                ("com.docker.compose.project", "kaname"),
                ("com.docker.compose.service", "pgbouncer"),
            ],
            networks: vec!["kaname_default"],
            mounts: vec![mount("/etc/pgbouncer", "/etc/pgbouncer", false)],
            process: "pgbouncer",
            process_args: "/usr/sbin/pgbouncer /etc/pgbouncer/pgbouncer.ini",
            process_user: "postgres",
            rss: 26 * MIB,
            mem_limit: 256 * MIB,
            cpu: 0.5,
            exit_code: 0,
            restarts: 0,
        },
        ContainerSeed {
            name: "uptime-kuma",
            image: "louislam/uptime-kuma:1.23.13",
            state: "running",
            age_days: 63,
            ports: vec![tcp(3001, 3001)],
            labels: vec![("maintainer", "louislam")],
            networks: vec!["bridge"],
            mounts: vec![mount("/srv/uptime-kuma", "/app/data", true)],
            process: "node",
            process_args: "node server/server.js",
            process_user: "root",
            rss: 176 * MIB,
            mem_limit: GIB,
            cpu: 1.7,
            exit_code: 0,
            restarts: 3,
        },
        ContainerSeed {
            name: "n8n",
            image: "n8nio/n8n:1.45.1",
            state: "exited",
            age_days: 12,
            ports: vec![tcp(5678, 5678)],
            labels: vec![
                ("com.docker.compose.project", "automation"),
                ("com.docker.compose.service", "n8n"),
            ],
            networks: vec!["automation_default"],
            mounts: vec![mount("/srv/n8n", "/home/node/.n8n", true)],
            process: "node",
            process_args: "node /usr/local/bin/n8n start",
            process_user: "node",
            rss: 0,
            mem_limit: GIB,
            cpu: 0.0,
            exit_code: 137,
            restarts: 2,
        },
        ContainerSeed {
            name: "watchtower",
            image: "containrrr/watchtower:1.7.1",
            state: "created",
            age_days: 3,
            ports: vec![],
            labels: vec![("com.centurylinklabs.watchtower", "true")],
            networks: vec!["bridge"],
            mounts: vec![mount("/var/run/docker.sock", "/var/run/docker.sock", false)],
            process: "watchtower",
            process_args: "/watchtower --cleanup --interval 3600",
            process_user: "root",
            rss: 0,
            mem_limit: 128 * MIB,
            cpu: 0.0,
            exit_code: 0,
            restarts: 0,
        },
    ]
}

const IMAGE_CATALOGUE: &[(&str, i64, i64, bool)] = &[
    ("redis:7-alpine", 41 * MIB, 45, true),
    ("minio/minio:RELEASE.2024-06-13T22-53-53Z", 178 * MIB, 45, true),
    ("edoburu/pgbouncer:1.22.1", 24 * MIB, 30, true),
    ("louislam/uptime-kuma:1.23.13", 462 * MIB, 70, true),
    ("n8nio/n8n:1.45.1", 703 * MIB, 14, true),
    ("containrrr/watchtower:1.7.1", 17 * MIB, 6, true),
    ("postgres:16-alpine", 254 * MIB, 118, false),
    ("<none>:<none>", 512 * MIB, 132, false),
    ("nginx:1.27-alpine", 48 * MIB, 91, false),
];

fn digest(seed: u64, i: u64, a: u64, b: u64, c: u64, d: u64) -> String {
    format!(
        "{:016x}{:016x}{:016x}{:016x}",
        mix(seed ^ i ^ a),
        mix(seed ^ i ^ b),
        mix(seed ^ i ^ c),
        mix(seed ^ i ^ d)
    )
}

pub fn build_containers(sim: &Sim) {
    let now = Utc::now();
    let mut w = sim.world.lock();

    w.containers = catalogue()
        .into_iter()
        .enumerate()
        .map(|(i, seed)| {
            let i = i as u64;
            let id = digest(sim.seed, i, 0xc1, 0xc2, 0xc3, 0xc4);
            let created = now - chrono::Duration::days(seed.age_days);

            let mut info = ContainerInfo {
                id,
                name: seed.name.into(),
                image: seed.image.into(),
                image_id: format!("sha256:{}", digest(sim.seed, i, 0xd1, 0xd2, 0xd3, 0xd4)),
                state: seed.state.into(),
                status: String::new(),
                created_at: stamp(created),
                started_at: None,
                ports: seed.ports,
                labels: seed
                    .labels
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect::<BTreeMap<_, _>>(),
                networks: seed.networks.iter().map(|n| n.to_string()).collect(),
                mounts: seed.mounts,
                restart_count: seed.restarts,
                cpu_percent: None,
                memory_usage: None,
                memory_limit: Some(seed.mem_limit),
                runtime: "docker".into(),
            };

            match seed.state {
                "running" => {
                    let started =
                        created + chrono::Duration::seconds((mix(sim.seed ^ i ^ 0xe1) % 3600) as i64);
                    info.started_at = Some(stamp(started));
                    info.status = format!("Up {}", human_duration(now - started));
                }
                "exited" => {
                    let stopped = now - chrono::Duration::hours(2 + (mix(sim.seed ^ i ^ 0xe2) % 40) as i64);
                    info.started_at = Some(stamp(created));
                    info.status = format!(
                        "Exited ({}) {} ago",
                        seed.exit_code,
                        human_duration(now - stopped)
                    );
                }
                _ => info.status = "Created".into(),
            }

            Container {
                info,
                process: seed.process.into(),
                process_args: seed.process_args.into(),
                process_user: seed.process_user.into(),
                rss_base: seed.rss,
                mem_limit: seed.mem_limit,
                cpu_base: seed.cpu,
                fs: None,
            }
        })
        .collect();

    w.images = IMAGE_CATALOGUE
        .iter()
        .enumerate()
        .map(|(i, (tag, size, age_days, in_use))| ImageInfo {
            id: format!("sha256:{}", digest(sim.seed, i as u64, 0xf1, 0xf2, 0xf3, 0xf4)),
            tags: vec![tag.to_string()],
            size: *size,
            created_at: stamp(now - chrono::Duration::days(*age_days)),
            in_use: *in_use,
        })
        .collect();
}

pub fn find_container(w: &World, id: &str) -> Option<usize> {
    w.containers
        .iter()
        .position(|c| c.info.id == id || c.info.name == id || (!id.is_empty() && c.info.id.starts_with(id)))
}

/// Fills the two columns that only mean anything while the container is up.
fn with_stats(sim: &Sim, c: &Container, now: DateTime<Utc>) -> ContainerInfo {
    let mut info = c.info.clone();
    if info.state != "running" {
        return info;
    }
    let t = now.timestamp_millis() as f64 / 1000.0;
    let seed = sim.seed ^ hash_string(&c.info.id);
    info.cpu_percent = Some(round2(clampf(
        c.cpu_base * (1.0 + 1.6 * drift(seed, t / 40.0, 2)),
        0.0,
        100.0,
    )));
    info.memory_usage = Some((c.rss_base as f64 * (1.0 + 0.14 * drift(seed ^ 0x3, t / 300.0, 2))) as i64);
    info
}

/// Rebuilds containerd's process set so the host process table always
/// agrees with the container table.
pub fn respawn_containerd(sim: &Sim, w: &mut World) {
    let Some(idx) = find_unit(w, "containerd.service") else {
        return;
    };
    if w.units[idx].info.active_state != "active" {
        return;
    }
    bring_down(w, idx, "inactive", "dead");
    bring_up(sim, w, idx, Utc::now());
}

/// Where the statefulness lives: the container's shim and main process
/// join or leave the host process table with it.
fn set_container_state(sim: &Sim, id: &str, state: &str) -> PResult<ContainerInfo> {
    let now = Utc::now();
    let info = {
        let mut w = sim.world.lock();
        let Some(idx) = find_container(&w, id) else {
            return Err(ProviderError::not_found(format!("container {id}")));
        };
        if w.containers[idx].info.state == state {
            return Ok(w.containers[idx].info.clone());
        }
        {
            let c = &mut w.containers[idx];
            c.info.state = state.into();
            match state {
                "running" => {
                    c.info.started_at = Some(stamp(now));
                    c.info.status = "Up 1 seconds".into();
                }
                "exited" => {
                    c.info.status = "Exited (0) 0 seconds ago".into();
                    c.info.cpu_percent = None;
                    c.info.memory_usage = None;
                }
                _ => {}
            }
        }
        respawn_containerd(sim, &mut w);
        w.containers[idx].info.clone()
    };

    sim.emit(
        topic::CONTAINER_CHANGED,
        serde_json::json!({"container_id": info.id, "name": info.name, "state": info.state}),
    );
    Ok(info)
}

pub struct SimContainers(pub Arc<Sim>);

#[async_trait]
impl Containers for SimContainers {
    async fn list(&self, _ctx: &Ctx, p: ContainerListParams) -> PResult<Vec<ContainerInfo>> {
        let now = Utc::now();
        let w = self.0.world.lock();
        let mut out: Vec<ContainerInfo> = w
            .containers
            .iter()
            .filter(|c| p.all || c.info.state == "running")
            .map(|c| {
                if p.with_stats {
                    with_stats(&self.0, c, now)
                } else {
                    c.info.clone()
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn inspect(&self, _ctx: &Ctx, id: &str) -> PResult<ContainerInspectResult> {
        let now = Utc::now();
        let w = self.0.world.lock();
        let Some(idx) = find_container(&w, id) else {
            return Err(ProviderError::not_found(format!("container {id}")));
        };
        let c = &w.containers[idx];
        let info = with_stats(&self.0, c, now);
        let mut fields = c.process_args.split_whitespace();
        let path = fields.next().unwrap_or_default().to_string();
        let args: Vec<String> = fields.map(str::to_string).collect();

        let raw = serde_json::json!({
            "Id": info.id,
            "Name": format!("/{}", info.name),
            "Created": info.created_at,
            "Path": path,
            "Args": args,
            "State": {
                "Status": info.state,
                "Running": info.state == "running",
                "Pid": 0,
                "StartedAt": info.started_at,
                "RestartCount": info.restart_count,
            },
            "Image": info.image_id,
            "Config": {
                "Hostname": &info.id[..12],
                "Image": info.image,
                "Labels": info.labels,
                "Env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
            },
            "HostConfig": {
                "RestartPolicy": {"Name": "unless-stopped"},
                "Memory": c.mem_limit,
                "NetworkMode": info.networks.first().cloned().unwrap_or_default(),
            },
            "Mounts": info.mounts,
        });
        Ok(ContainerInspectResult { container: info, raw })
    }

    async fn start(&self, _ctx: &Ctx, id: &str) -> PResult<ContainerInfo> {
        set_container_state(&self.0, id, "running")
    }

    async fn stop(&self, _ctx: &Ctx, p: ContainerStopParams) -> PResult<ContainerInfo> {
        set_container_state(&self.0, &p.id, "exited")
    }

    async fn restart(&self, _ctx: &Ctx, p: ContainerStopParams) -> PResult<ContainerInfo> {
        set_container_state(&self.0, &p.id, "exited")?;
        let mut info = set_container_state(&self.0, &p.id, "running")?;
        let mut w = self.0.world.lock();
        if let Some(idx) = find_container(&w, &p.id) {
            w.containers[idx].info.restart_count += 1;
            info = w.containers[idx].info.clone();
        }
        Ok(info)
    }

    async fn remove(&self, _ctx: &Ctx, p: ContainerRemoveParams) -> PResult<()> {
        let (id, name) = {
            let mut w = self.0.world.lock();
            let Some(idx) = find_container(&w, &p.id) else {
                return Err(ProviderError::not_found(format!("container {}", p.id)));
            };
            if w.containers[idx].info.state == "running" && !p.force {
                return Err(ProviderError::conflict(format!(
                    "container {} is running",
                    w.containers[idx].info.name
                )));
            }
            let target = w.containers.remove(idx);
            respawn_containerd(&self.0, &mut w);
            (target.info.id, target.info.name)
        };
        self.0.emit(
            topic::CONTAINER_CHANGED,
            serde_json::json!({"container_id": id, "name": name, "state": "removed"}),
        );
        Ok(())
    }

    async fn logs(&self, ctx: &Ctx, p: ContainerLogsParams, s: StreamRef) -> PResult<Vec<LogRecord>> {
        let name = {
            let w = self.0.world.lock();
            let Some(idx) = find_container(&w, &p.id) else {
                return Err(ProviderError::not_found(format!("container {}", p.id)));
            };
            w.containers[idx].info.name.clone()
        };
        logs::tail(
            &self.0,
            ctx,
            &*s,
            TailRequest {
                source: logs::SOURCE_CONTAINER.into(),
                container: name,
                lines: p.lines,
                follow: p.follow,
                since: p.since,
                ..Default::default()
            },
        )
        .await
    }

    async fn exec(&self, ctx: &Ctx, p: ContainerExecParams, s: StreamRef) -> PResult<()> {
        let (fs, name, short_id) = {
            let mut w = self.0.world.lock();
            let Some(idx) = find_container(&w, &p.id) else {
                return Err(ProviderError::not_found(format!("container {}", p.id)));
            };
            if w.containers[idx].info.state != "running" {
                return Err(ProviderError::PreconditionFailed(format!(
                    "container {} is not running",
                    w.containers[idx].info.name
                )));
            }
            if w.containers[idx].fs.is_none() {
                let fs = files::build_container_filesystem(&w.containers[idx]);
                w.containers[idx].fs = Some(fs);
            }
            let c = &w.containers[idx];
            (
                c.fs.clone().expect("container filesystem"),
                c.info.name.clone(),
                c.info.id[..12].to_string(),
            )
        };

        let session = PtySession::for_container(self.0.clone(), fs, &name, &short_id, p.cols, p.rows);
        session.run(ctx, &*s).await.map(|_| ())
    }

    async fn images(&self, _ctx: &Ctx) -> PResult<Vec<ImageInfo>> {
        Ok(self.0.world.lock().images.clone())
    }

    async fn prune(&self, _ctx: &Ctx, p: ContainerPruneParams) -> PResult<ContainerPruneResult> {
        let mut w = self.0.world.lock();
        let mut removed = Vec::new();
        let mut reclaimed: i64 = 0;

        let containers = std::mem::take(&mut w.containers);
        for c in containers {
            if c.info.state == "exited" {
                removed.push(c.info.id.clone());
                reclaimed += c.rss_base + 64 * MIB;
            } else {
                w.containers.push(c);
            }
        }

        if p.include_images {
            let images = std::mem::take(&mut w.images);
            for image in images {
                if !image.in_use {
                    removed.push(image.id.clone());
                    reclaimed += image.size;
                } else {
                    w.images.push(image);
                }
            }
        }
        if p.include_volumes {
            reclaimed += 1_284_374_528;
            removed.push("kaname_redis_stale".into());
            removed.push("automation_n8n_old".into());
        }

        respawn_containerd(&self.0, &mut w);
        Ok(ContainerPruneResult {
            reclaimed_bytes: reclaimed,
            removed,
        })
    }

    async fn pull_image(&self, ctx: &Ctx, p: ImagePullParams, s: StreamRef) -> PResult<ImagePullResult> {
        managed::validate_image(&p.image)?;
        let id = self.image_id(&p.image);
        let present = self
            .0
            .world
            .lock()
            .images
            .iter()
            .any(|i| i.tags.contains(&p.image));
        say(s.as_ref(), format!("pulling {}", p.image)).await;
        if present {
            say(s.as_ref(), format!("Status: Image is up to date for {}", p.image)).await;
        } else {
            for layer in 0..3u64 {
                ctx.check()?;
                let short = format!("{:012x}", mix(hash_string(&p.image) ^ layer));
                say(s.as_ref(), format!("{short}: Pull complete")).await;
            }
            say(
                s.as_ref(),
                format!("Status: Downloaded newer image for {}", p.image),
            )
            .await;
            self.0.world.lock().images.push(ImageInfo {
                id: id.clone(),
                tags: vec![p.image.clone()],
                size: 180 * MIB + (hash_string(&p.image) % 400) as i64 * MIB,
                created_at: stamp(Utc::now()),
                in_use: false,
            });
        }
        Ok(ImagePullResult { image: p.image, id })
    }

    async fn create_network(&self, _ctx: &Ctx, install_id: &str) -> PResult<ManagedNetworkResult> {
        managed::validate_install_id(install_id)?;
        let name = managed::network_name(install_id);
        let mut w = self.0.world.lock();
        if let Some((_, id, labels)) = w.networks.iter().find(|(n, _, _)| *n == name) {
            if !managed::is_managed_by(labels, install_id) {
                return Err(ProviderError::conflict(format!(
                    "a network named {name} exists and was not created by Kaname"
                )));
            }
            return Ok(ManagedNetworkResult {
                name,
                id: id.clone(),
                created: false,
            });
        }
        let id = format!(
            "{:016x}{:048x}",
            hash_string(&name),
            mix(self.0.seed ^ hash_string(&name))
        );
        w.networks
            .push((name.clone(), id.clone(), managed::install_labels(install_id)));
        Ok(ManagedNetworkResult {
            name,
            id,
            created: true,
        })
    }

    async fn create_managed(&self, _ctx: &Ctx, mut spec: ManagedContainerSpec) -> PResult<ContainerInfo> {
        // The handler validated already; the simulator checks again so a
        // test that drives it directly meets the same guards.
        managed::validate_spec(&mut spec, managed::MANAGED_APPS_ROOT)?;
        let network = managed::network_name(&spec.install_id);
        let name = managed::container_name(&spec.install_id, &spec.role);
        let image_id = self.image_id(&spec.image);
        let info = {
            let mut w = self.0.world.lock();
            if !w
                .networks
                .iter()
                .any(|(n, _, l)| *n == network && managed::is_managed_by(l, &spec.install_id))
            {
                return Err(ProviderError::PreconditionFailed(format!(
                    "the install's network {network} does not exist; create it first"
                )));
            }
            if !w.images.iter().any(|i| i.tags.contains(&spec.image)) {
                return Err(ProviderError::not_found(format!("No such image: {}", spec.image)));
            }
            if let Some(idx) = find_container(&w, &name) {
                let labels = &w.containers[idx].info.labels;
                let ours = managed::is_managed_by(labels, &spec.install_id)
                    && labels.get(managed::LABEL_ROLE) == Some(&spec.role);
                if !ours {
                    return Err(ProviderError::conflict(format!(
                        "a container named {name} exists and was not created by Kaname"
                    )));
                }
                if !spec.replace {
                    return Err(ProviderError::conflict(format!(
                        "container {name} already exists"
                    )));
                }
                w.containers.remove(idx);
            }
            for port in &spec.ports {
                let taken = w.containers.iter().any(|c| {
                    c.info.state == "running"
                        && c.info.ports.iter().any(|p| p.host_port == Some(port.host_port))
                });
                if taken {
                    return Err(ProviderError::conflict(format!(
                        "Bind for 127.0.0.1:{} failed: port is already allocated",
                        port.host_port
                    )));
                }
            }
            let now = Utc::now();
            let (process, args, user) = process_for(&spec.image);
            let info = ContainerInfo {
                id: format!(
                    "{:016x}{:048x}",
                    hash_string(&name),
                    mix(self.0.seed ^ hash_string(&name) ^ now.timestamp_millis() as u64)
                ),
                name: name.clone(),
                image: spec.image.clone(),
                image_id,
                state: "running".into(),
                status: "Up 1 seconds".into(),
                created_at: stamp(now),
                started_at: Some(stamp(now)),
                ports: spec
                    .ports
                    .iter()
                    .map(|p| ContainerPort {
                        container_port: p.container_port,
                        host_port: Some(p.host_port),
                        host_ip: Some(managed::LOOPBACK.into()),
                        protocol: "tcp".into(),
                    })
                    .collect(),
                labels: managed::container_labels(&spec.install_id, &spec.role),
                networks: vec![network],
                mounts: spec
                    .mounts
                    .iter()
                    .map(|m| ContainerMount {
                        source: m.source.clone(),
                        destination: m.target.clone(),
                        rw: !m.read_only,
                    })
                    .collect(),
                restart_count: 0,
                cpu_percent: None,
                memory_usage: None,
                memory_limit: spec.memory_bytes,
                runtime: "docker".into(),
            };
            for image in w.images.iter_mut().filter(|i| i.tags.contains(&spec.image)) {
                image.in_use = true;
            }
            if !spec.mounts.is_empty() {
                w.app_data.insert(spec.install_id.clone());
            }
            w.containers.push(Container {
                info: info.clone(),
                process: process.into(),
                process_args: args.into(),
                process_user: user.into(),
                rss_base: 160 * MIB,
                mem_limit: spec.memory_bytes.unwrap_or(GIB),
                cpu_base: 1.2,
                fs: None,
            });
            respawn_containerd(&self.0, &mut w);
            info
        };
        self.0.emit(
            topic::CONTAINER_CHANGED,
            serde_json::json!({"container_id": info.id, "name": info.name, "state": info.state}),
        );
        Ok(info)
    }

    async fn run_task(&self, _ctx: &Ctx, mut p: ManagedTaskParams) -> PResult<ManagedTaskResult> {
        managed::validate_task(&mut p.spec, p.timeout_seconds.max(1), managed::MANAGED_APPS_ROOT)?;
        let network = managed::network_name(&p.spec.install_id);
        let w = self.0.world.lock();
        if !w.networks.iter().any(|(n, _, l)| *n == network && managed::is_managed_by(l, &p.spec.install_id)) {
            return Err(ProviderError::PreconditionFailed(format!(
                "the install's network {network} does not exist; create it first"
            )));
        }
        if !w.images.iter().any(|i| i.tags.contains(&p.spec.image)) {
            return Err(ProviderError::not_found(format!("No such image: {}", p.spec.image)));
        }
        Ok(ManagedTaskResult {
            exit_code: 0,
            output: format!("{} {}: done\n", p.spec.image, p.spec.args.join(" ")),
        })
    }

    async fn app_status(&self, _ctx: &Ctx, install_id: &str) -> PResult<ManagedAppStatus> {
        managed::validate_install_id(install_id)?;
        let w = self.0.world.lock();
        let mut status = ManagedAppStatus::default();
        for c in w
            .containers
            .iter()
            .filter(|c| managed::is_managed_by(&c.info.labels, install_id))
        {
            let role = c
                .info
                .labels
                .get(managed::LABEL_ROLE)
                .cloned()
                .unwrap_or_default();
            let running = c.info.state == "running";
            for port in &c.info.ports {
                let Some(host_port) = port.host_port else { continue };
                status.endpoints.push(ManagedEndpoint {
                    role: role.clone(),
                    host_port,
                    container_port: port.container_port,
                    reachable: running,
                    http_status: running.then_some(200),
                });
            }
            status.containers.push(ManagedContainerState {
                role,
                name: c.info.name.clone(),
                state: c.info.state.clone(),
                status: c.info.status.clone(),
            });
        }
        status.containers.sort_by(|a, b| a.role.cmp(&b.role));
        Ok(status)
    }

    async fn remove_app(&self, _ctx: &Ctx, p: ManagedAppRemoveParams) -> PResult<ManagedAppRemoveResult> {
        managed::validate_install_id(&p.install_id)?;
        let mut result = ManagedAppRemoveResult::default();
        let removed: Vec<(String, String)> = {
            let mut w = self.0.world.lock();
            let containers = std::mem::take(&mut w.containers);
            let mut removed = Vec::new();
            for c in containers {
                if managed::is_managed_by(&c.info.labels, &p.install_id) {
                    removed.push((c.info.id.clone(), c.info.name.clone()));
                } else {
                    w.containers.push(c);
                }
            }
            let networks = std::mem::take(&mut w.networks);
            for network in networks {
                if managed::is_managed_by(&network.2, &p.install_id) {
                    result.networks.push(network.0);
                } else {
                    w.networks.push(network);
                }
            }
            if p.remove_data {
                result.data_removed = w.app_data.remove(&p.install_id);
            }
            respawn_containerd(&self.0, &mut w);
            removed
        };
        for (id, name) in removed {
            self.0.emit(
                topic::CONTAINER_CHANGED,
                serde_json::json!({"container_id": id, "name": name, "state": "removed"}),
            );
            result.containers.push(name);
        }
        Ok(result)
    }
}

/* ----------------------- managed app containers --------------------- */

/// A plausible main process for a managed container, so the host process
/// table has something to show while it runs.
fn process_for(image: &str) -> (&'static str, &'static str, &'static str) {
    let repo = image.split([':', '@']).next().unwrap_or(image);
    let repo = repo.rsplit('/').next().unwrap_or(repo);
    match repo {
        "mysql" | "mariadb" => ("mysqld", "mysqld", "mysql"),
        "postgres" => ("postgres", "postgres -D /var/lib/postgresql/data", "postgres"),
        "nextcloud" => ("apache2", "apache2 -DFOREGROUND", "www-data"),
        "gitea" => ("gitea", "/usr/local/bin/gitea web", "git"),
        _ => ("node", "node current/index.js", "node"),
    }
}

impl SimContainers {
    fn image_id(&self, image: &str) -> String {
        format!(
            "sha256:{:016x}{:048x}",
            hash_string(image),
            mix(self.0.seed ^ hash_string(image))
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use parking_lot::Mutex;

    use super::*;
    use crate::providers::{Encoding, Options, Stream};

    /// Types the given keystrokes, then hangs up, and keeps what came back.
    struct Keyboard {
        input: Mutex<VecDeque<Vec<u8>>>,
        output: Mutex<Vec<u8>>,
    }

    #[async_trait]
    impl Stream for Keyboard {
        async fn send(&self, data: &[u8], _enc: Encoding) -> PResult<()> {
            self.output.lock().extend_from_slice(data);
            Ok(())
        }
        async fn recv(&self) -> PResult<Option<Vec<u8>>> {
            Ok(self.input.lock().pop_front())
        }
    }

    fn sim(name: &str) -> Arc<Sim> {
        Sim::new(Options {
            agent_version: "0.1.0".into(),
            state_dir: std::env::temp_dir().join(format!("kaname-sim-containers-{name}")),
        })
    }

    async fn exec(sim: &Arc<Sim>, id: &str, typed: &[&str]) -> PResult<String> {
        let keyboard = Arc::new(Keyboard {
            input: Mutex::new(typed.iter().map(|t| t.as_bytes().to_vec()).collect()),
            output: Mutex::new(Vec::new()),
        });
        SimContainers(sim.clone())
            .exec(
                &Ctx::background(),
                ContainerExecParams {
                    id: id.into(),
                    cols: 80,
                    rows: 24,
                },
                keyboard.clone(),
            )
            .await?;
        let out = String::from_utf8_lossy(&keyboard.output.lock()).into_owned();
        Ok(out)
    }

    /// The Exec tab's whole promise: what you type runs inside the
    /// container, against its filesystem and its hostname, not the host's.
    #[tokio::test]
    async fn exec_lands_inside_the_container_not_on_the_host() {
        let sim = sim("exec");
        let short = {
            let w = sim.world.lock();
            let idx = find_container(&w, "kaname-redis").expect("seeded redis");
            w.containers[idx].info.id[..12].to_string()
        };

        let out = exec(
            &sim,
            "kaname-redis",
            &["hostname\r", "cat /etc/os-release\r", "exit\r"],
        )
        .await
        .expect("exec into a running container");
        assert!(out.contains("Inside container"), "{out}");
        assert!(out.contains("kaname-redis"), "{out}");
        assert!(
            out.contains(&format!("\r\n{short}\r\n")),
            "hostname should be the container's: {out}"
        );
        assert!(!out.contains(&format!("\r\n{}\r\n", sim.id.hostname)), "{out}");
        assert!(out.contains("Alpine Linux"), "{out}");
        assert!(out.contains(&format!("root@{short}")), "{out}");
        sim.close().await;
    }

    const INSTALL: &str = "0f0e0d0c-0b0a-4908-8706-050403020100";

    struct Sink(Mutex<Vec<u8>>);

    #[async_trait]
    impl Stream for Sink {
        async fn send(&self, data: &[u8], _enc: Encoding) -> PResult<()> {
            self.0.lock().extend_from_slice(data);
            Ok(())
        }
        async fn recv(&self) -> PResult<Option<Vec<u8>>> {
            Ok(None)
        }
    }

    fn app_spec(role: &str, image: &str, host_port: Option<i64>) -> ManagedContainerSpec {
        ManagedContainerSpec {
            install_id: INSTALL.into(),
            role: role.into(),
            image: image.into(),
            mounts: vec![crate::providers::ManagedMount {
                source: format!("{}/{INSTALL}/{role}", managed::MANAGED_APPS_ROOT),
                target: "/data".into(),
                ..Default::default()
            }],
            ports: host_port
                .map(|h| {
                    vec![crate::providers::ManagedPort {
                        container_port: 2368,
                        host_port: h,
                    }]
                })
                .unwrap_or_default(),
            replace: true,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_managed_app_is_pulled_networked_started_probed_and_removed() {
        let sim = sim("managed");
        let c = SimContainers(sim.clone());
        let ctx = Ctx::background();

        // No network yet: refused before anything is created.
        let early = c.create_managed(&ctx, app_spec("db", "mysql:8.0", None)).await;
        assert!(
            matches!(early, Err(ProviderError::PreconditionFailed(_))),
            "{early:?}"
        );

        let net = c.create_network(&ctx, INSTALL).await.unwrap();
        assert!(net.created);
        assert!(
            !c.create_network(&ctx, INSTALL).await.unwrap().created,
            "idempotent"
        );

        // An image that was never pulled is not there to run.
        let missing = c.create_managed(&ctx, app_spec("db", "mysql:8.0", None)).await;
        assert!(matches!(missing, Err(ProviderError::NotFound(_))), "{missing:?}");

        let sink = Arc::new(Sink(Mutex::new(Vec::new())));
        for image in ["mysql:8.0", "ghost:5"] {
            c.pull_image(&ctx, ImagePullParams { image: image.into() }, sink.clone())
                .await
                .unwrap();
        }
        assert!(String::from_utf8_lossy(&sink.0.lock()).contains("Downloaded newer image for ghost:5"));

        let db = c
            .create_managed(&ctx, app_spec("db", "mysql:8.0", None))
            .await
            .unwrap();
        assert_eq!(db.name, format!("kaname-{INSTALL}-db"));
        let app = c
            .create_managed(&ctx, app_spec("app", "ghost:5", Some(20001)))
            .await
            .unwrap();
        assert_eq!(app.ports[0].host_ip.as_deref(), Some("127.0.0.1"));
        assert!(managed::is_managed_by(&app.labels, INSTALL));

        // Replace is the idempotent path a resumed install takes.
        c.create_managed(&ctx, app_spec("app", "ghost:5", Some(20001)))
            .await
            .unwrap();
        let mut again = app_spec("app", "ghost:5", Some(20001));
        again.replace = false;
        assert!(matches!(
            c.create_managed(&ctx, again).await,
            Err(ProviderError::Conflict(_))
        ));

        let status = c.app_status(&ctx, INSTALL).await.unwrap();
        assert_eq!(
            status
                .containers
                .iter()
                .map(|c| c.role.as_str())
                .collect::<Vec<_>>(),
            ["app", "db"]
        );
        assert_eq!(status.endpoints.len(), 1);
        assert!(status.endpoints[0].reachable);

        let removed = c
            .remove_app(
                &ctx,
                ManagedAppRemoveParams {
                    install_id: INSTALL.into(),
                    remove_data: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(removed.containers.len(), 2);
        assert_eq!(removed.networks, vec![format!("kaname-{INSTALL}")]);
        assert!(removed.data_removed);
        assert!(c.app_status(&ctx, INSTALL).await.unwrap().containers.is_empty());
        sim.close().await;
    }

    #[tokio::test]
    async fn the_destructive_verb_never_touches_unlabelled_containers() {
        let sim = sim("managed-labels");
        let c = SimContainers(sim.clone());
        let before = sim.world.lock().containers.len();
        // A container someone named like a managed one is still not ours.
        {
            let mut w = sim.world.lock();
            w.containers[0].info.name = format!("kaname-{INSTALL}-app");
        }
        let removed = c
            .remove_app(
                &Ctx::background(),
                ManagedAppRemoveParams {
                    install_id: INSTALL.into(),
                    remove_data: true,
                },
            )
            .await
            .unwrap();
        assert!(removed.containers.is_empty());
        assert_eq!(sim.world.lock().containers.len(), before);

        // And create will not replace it either.
        c.create_network(&Ctx::background(), INSTALL).await.unwrap();
        c.pull_image(
            &Ctx::background(),
            ImagePullParams {
                image: "ghost:5".into(),
            },
            Arc::new(Sink(Mutex::new(Vec::new()))),
        )
        .await
        .unwrap();
        let clash = c
            .create_managed(&Ctx::background(), app_spec("app", "ghost:5", Some(20002)))
            .await;
        assert!(matches!(clash, Err(ProviderError::Conflict(_))), "{clash:?}");
        sim.close().await;
    }

    #[tokio::test]
    async fn a_spec_that_escapes_the_guards_is_refused_by_the_simulator_too() {
        let sim = sim("managed-guards");
        let c = SimContainers(sim.clone());
        c.create_network(&Ctx::background(), INSTALL).await.unwrap();
        let mut spec = app_spec("app", "ghost:5", Some(20003));
        spec.mounts[0].source = "/var/run/docker.sock".into();
        assert!(matches!(
            c.create_managed(&Ctx::background(), spec).await,
            Err(ProviderError::PermissionDenied(_))
        ));
        sim.close().await;
    }

    #[tokio::test]
    async fn exec_into_a_stopped_or_missing_container_is_refused() {
        let sim = sim("exec-refused");
        let stopped = {
            let w = sim.world.lock();
            w.containers
                .iter()
                .find(|c| c.info.state != "running")
                .map(|c| c.info.name.clone())
                .expect("the seed has a container that is not running")
        };
        match exec(&sim, &stopped, &[]).await {
            Err(ProviderError::PreconditionFailed(msg)) => assert!(msg.contains(&stopped), "{msg}"),
            other => panic!("expected PreconditionFailed, got {other:?}"),
        }
        assert!(matches!(
            exec(&sim, "no-such-container", &[]).await,
            Err(ProviderError::NotFound(_))
        ));
        sim.close().await;
    }
}
