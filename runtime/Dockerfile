FROM public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app
COPY --chmod=0444 control_plane.py guard.py entrypoint.py /app/
COPY --chmod=0555 codex /opt/bma/bin/codex
EXPOSE 8080
USER 1000:1000
CMD ["python3", "-u", "/app/entrypoint.py"]
