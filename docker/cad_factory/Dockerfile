FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    wget \
    curl \
    build-essential \
    autoconf \
    automake \
    libtool \
    libtool-bin \
    pkg-config \
    bison \
    flex \
    texinfo \
    swig \
    file \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Build LibreDWG from source to support newer DWG versions than libopencad.
RUN git clone --depth 1 --branch 0.13.4 https://github.com/LibreDWG/libredwg.git \
    && cd libredwg \
    && ./autogen.sh \
    && ./configure --prefix=/usr/local --disable-bindings \
    && make -j"$(nproc)" \
    && make install \
    && ldconfig \
    && cd /opt \
    && rm -rf /opt/libredwg

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir ezdxf==1.4.3

# The container runs as DOCKER_UID:DOCKER_GID without a home directory, so
# ezdxf couldn't write its font cache to ~/.cache/ezdxf ("Cannot create cache
# home directory: '/.cache/ezdxf'") and rebuilt it on every run. It is built
# once here instead. Unbuffered output: the backend streams the log live.
ENV PATH="/opt/venv/bin:${PATH}" \
    HOME=/tmp \
    XDG_CACHE_HOME=/opt/cache \
    PYTHONUNBUFFERED=1
RUN python -c "from ezdxf.fonts import fonts; fonts.build_system_font_cache()" \
    && chmod -R a+rwX /opt/cache

WORKDIR /workspace
COPY ./docker/cad_factory/dwg_helper.py /usr/local/bin/dwg_helper.py
RUN chmod +x /usr/local/bin/dwg_helper.py

ENTRYPOINT ["/opt/venv/bin/python", "/usr/local/bin/dwg_helper.py"]
