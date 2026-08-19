#!/usr/bin/env bash
# Reap an apt that a timed-out step left running.
#
# `timeout` kills the process it started, not that process's children. When an
# `apt-get` (or a `playwright install --with-deps`, which shells out to one) is
# cut short, the apt underneath can survive holding /var/lib/dpkg/lock-frontend.
# Every retry then fails in under a second with "Could not get lock", which is
# how a retry loop turns one stuck download into three failures and looks like a
# broken pull request rather than a broken mirror.
#
# Sourced rather than inlined so both steps share one definition, and so it can
# be shellcheck'd like the rest of the repository's shell.

# shellcheck disable=SC2317  # sourced, so callers are outside this file
release_apt_locks() {
  # Stop the survivors first: removing a lock file held by a live process just
  # invites two package managers to write at once.
  sudo pkill -9 -x apt-get || true
  sudo pkill -9 -x apt || true
  sudo pkill -9 -x dpkg || true

  # Give the kernel a moment to release the file handles.
  sleep 2

  sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock \
    /var/cache/apt/archives/lock || true

  # A package interrupted mid-configure leaves dpkg needing this before it will
  # accept anything else. Safe when there is nothing to do.
  sudo dpkg --configure -a || true
}
