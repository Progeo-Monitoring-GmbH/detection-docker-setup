"""Shared base for management commands.

The only difference to Django's BaseCommand is the help formatter: it keeps
the line breaks and indentation of the command's `help` text, so usage
examples render as proper lines instead of one collapsed paragraph, while
keeping Django's ordering of command-specific arguments.
"""
from django.core.management.base import BaseCommand as _DjangoBaseCommand
from django.core.management.base import DjangoHelpFormatter


class _RawHelpFormatter(DjangoHelpFormatter):
    """DjangoHelpFormatter that preserves line breaks in the description."""

    def _fill_text(self, text, width, indent):
        return text


class BaseCommand(_DjangoBaseCommand):
    def create_parser(self, prog_name, subcommand, **kwargs):
        kwargs.setdefault("formatter_class", _RawHelpFormatter)
        return super().create_parser(prog_name, subcommand, **kwargs)
