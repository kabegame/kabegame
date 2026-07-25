docker compose -f docker/docker-compose.web-release.yml build     # 重建镜像(新增 scp install 层)
docker compose -f docker/docker-compose.web-release.yml run --rm build
