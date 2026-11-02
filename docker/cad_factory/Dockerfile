# progeo-cad_factory: reads the measure points of a DWG/DXF plan and renders
# plan PDFs as Lageplan PNG (docker/cad_factory/cad_reader.py). DWG with
# ezdwg - no conversion to DXF -, PDF with PyMuPDF.

# ezdwg is built from its sdist with ezdwg-r2004-long-offsets.patch: its
# decompressor misreads back-references beyond 32 KiB, so it can't open DWGs
# with ~2200+ pages (e.g. the 31 MB Data Center plans) - drop the patch (and
# install the ezdwg wheel from PyPI) once ezdwg fixes that.
FROM python:3.13.7-slim-bookworm AS ezdwg-wheel
ARG EZDWG_VERSION=0.19.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"
COPY --from=rust:1.90.0-slim-bookworm /usr/local/rustup /usr/local/rustup
COPY --from=rust:1.90.0-slim-bookworm /usr/local/cargo /usr/local/cargo
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev patch \
    && rm -rf /var/lib/apt/lists/*
COPY ./docker/cad_factory/ezdwg-r2004-long-offsets.patch /tmp/ezdwg.patch
# The sdist is fetched directly (hash-checked): `pip download` would build its metadata first.
RUN python -c "import hashlib, json, sys, urllib.request; \
version = sys.argv[1]; \
release = json.load(urllib.request.urlopen(f'https://pypi.org/pypi/ezdwg/{version}/json')); \
sdist = next(f for f in release['urls'] if f['packagetype'] == 'sdist'); \
data = urllib.request.urlopen(sdist['url']).read(); \
assert hashlib.sha256(data).hexdigest() == sdist['digests']['sha256'], 'sdist hash mismatch'; \
open('/tmp/ezdwg.tar.gz', 'wb').write(data)" "${EZDWG_VERSION}" \
    && mkdir /tmp/ezdwg \
    && tar -xzf /tmp/ezdwg.tar.gz -C /tmp/ezdwg --strip-components=1 \
    && sed -i 's/\r$//' /tmp/ezdwg.patch \
    && patch -d /tmp/ezdwg -p1 < /tmp/ezdwg.patch \
    && pip wheel --no-deps -w /wheels /tmp/ezdwg

FROM python:3.13.7-slim-bookworm

# The container runs as DOCKER_UID:DOCKER_GID without a home directory, so
# ezdxf couldn't write its font cache to ~/.cache/ezdxf ("Cannot create cache
# home directory: '/.cache/ezdxf'") and rebuilt it on every run. It is built
# once here instead. Unbuffered output: the backend streams the log live.
ENV HOME=/tmp \
    XDG_CACHE_HOME=/opt/cache \
    PYTHONUNBUFFERED=1

COPY --from=ezdwg-wheel /wheels /tmp/wheels
RUN pip install --no-cache-dir /tmp/wheels/*.whl ezdxf==1.4.5 pymupdf==1.28.2 \
    && rm -rf /tmp/wheels \
    && python -c "from ezdxf.fonts import fonts; fonts.build_system_font_cache()" \
    && chmod -R a+rwX /opt/cache

WORKDIR /workspace
COPY ./docker/cad_factory/cad_reader.py /usr/local/bin/cad_reader.py

ENTRYPOINT ["python", "/usr/local/bin/cad_reader.py"]
