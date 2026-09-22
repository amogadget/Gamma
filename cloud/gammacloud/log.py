"""The account server's logger. Secrets never reach it: every token is
hashed before it is stored and mail links are logged only by the console
mail backend, which is a development setting."""

import logging

log = logging.getLogger("gammacloud")
