# Aletheia, for the JPEG DCT carrier that zsteg and StegExpose cannot see.
#
# Why a container at all: Aletheia needs Octave with three toolboxes, ImageMagick,
# steghide and outguess, plus a TensorFlow stack. None of that belongs on a
# developer's machine, and the nightly CI job runs the same image.
#
# Why the TensorFlow pin is overridden. Aletheia requires
# `tensorflow==2.15.0.post1`, which publishes **only manylinux x86_64 wheels**: no
# macOS build, no arm64 build, nothing for Python 3.12+. On an Apple Silicon host
# that leaves emulation, and emulated x86 TensorFlow never finished booting here.
# TensorFlow 2.16+ publishes linux/aarch64 wheels, so the bound is relaxed and the
# consequence is made visible instead of assumed: the outguess control runs first,
# and if a TensorFlow difference broke the detectors it fails there rather than
# silently returning "clean" for everything.
#
# `build-essential` is required, not optional: the JPEG TOOLBOX ships as source and
# Aletheia compiles it on first use, so without `make` the JPEG detectors fail with
# "jpeg_read undefined" after the licence prompts have already been answered.
#
# Two further third-party licences are presented at run time for the NSF5_COLOR and
# J_UNIWARD_COLOR reference implementations (Binghamton DDE). They are research
# code with the same non-commercial character as the UC toolbox, and the same note
# applies: revisit all of it if the project stops being non-profit.
#
# outguess is the control generator, not a detector. Aletheia ships a detector
# trained specifically on Outguess, so an outguess-embedded JPEG is the one sample
# these models must flag. It is installed here because Homebrew's outguess cask was
# disabled in February 2026 and the upstream project has been archived since 2021.
#
# ---------------------------------------------------------------------------
# LICENCE DECISION, revisit if StegoShard ever stops being non-profit
# ---------------------------------------------------------------------------
# Any JPEG analysis through Aletheia requires the JPEG TOOLBOX (Regents of the
# University of California, 2003), whose licence permits use "for educational,
# research and non-profit purposes" only and requires contacting UC before
# incorporating it into commercial products.
#
# This is not confined to the `calibration` attack, which was the first
# assumption. `aletheia.py auto` calls `download_octave_jpeg_toolbox()`
# unconditionally as soon as one JPEG is present (aletheialib/options/auto.py:218)
# because the toolbox is how it reads DCT coefficients at all. Choosing the
# learned detectors over calibration therefore does **not** avoid the licence, and
# no JPEG path through this tool does.
#
# Accepted here on the basis that StegoShard is a non-profit project. **If that
# ever changes, this image and the nightly workflow that runs it must be removed
# or the licence renegotiated with UC.** The PNG suite in tests/steganalysis is
# unaffected: zsteg and StegExpose carry no such term.
#
# On the choice itself: calibration is deterministic but was designed for the
# F5/JSteg family, so its fit to this scheme is not a given, while the learned
# detectors cover more schemes at the cost of an ambiguous "clean" (undetectable,
# or outside the training distribution). Neither is clearly better, and the
# outguess control is what keeps the learned path honest.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git build-essential \
      octave octave-image octave-signal octave-nan octave-dev \
      imagemagick steghide outguess \
      libmagic1 \
    && rm -rf /var/lib/apt/lists/*

# Install Aletheia without its dependency resolution, then supply the stack with a
# TensorFlow that exists for this architecture. Keeping the two steps apart makes
# the substitution explicit rather than buried in a resolver decision.
RUN pip3 install --no-cache-dir "tensorflow>=2.16,<2.20"
# `efficientnet` backs the JPEG detectors and imports cleanly against TensorFlow
# 2.19. `steganogan` is deliberately absent: it fails to build here, and it backs
# only the SteganoGAN *spatial* detector, which is not what this image is for. Its
# absence is visible as a pip resolver warning rather than hidden.
RUN pip3 install --no-cache-dir \
      imageio numpy scipy scikit-learn pandas hdf5storage h5py \
      matplotlib python-magic Pillow efficientnet
RUN pip3 install --no-cache-dir --no-deps git+https://github.com/daniellerch/aletheia

WORKDIR /work
