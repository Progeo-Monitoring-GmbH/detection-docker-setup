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
    && ./configure --prefix=/usr/local --disable-bindings
RUN make -j"$(nproc)"
RUN make install
RUN ldconfig \
    && cd /opt \
    && rm -rf /opt/libredwg

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir ezdxf==1.4.3

ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /workspace
COPY ./docker/cad_factory/dwg_helper.py /usr/local/bin/dwg_helper.py
RUN chmod +x /usr/local/bin/dwg_helper.py

ENTRYPOINT ["/opt/venv/bin/python", "/usr/local/bin/dwg_helper.py"]
