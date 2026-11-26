# 容器台

在 DSH 左侧「容器」面板中管理本机 rootless Podman 与 LXC。

- Podman：compose 项目、容器、镜像、卷、网络、Pod、secret、Quadlet。
- LXC：容器、系统镜像缓存、网络、存储、快照、克隆、挂载点、备份。
- 运维：宿主网络、能力体检、告警、审计、任务队列、回收站。
- AI 工具与面板共用同一动作层；危险操作由应用 owner 在面板确认。

本机没有 `lxc export` 时，LXC 导出与自动备份会明确停用，不会假装成功。
