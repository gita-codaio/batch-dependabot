#!/usr/bin/env bash
echo "$1"
PACKAGE_FILES=$(ls -C1 package.json Pipfile 2> /dev/null || true)
(git diff "origin/$1~...origin/$1" -- ${PACKAGE_FILES} | grep -e "^- " -e "^+ ") \
&& git diff "origin/$1~...origin/$1" -- ${PACKAGE_FILES} | git apply -C0  || echo "${bldred}WARNING: Skipping failed patch ${1}"
