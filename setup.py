from setuptools import setup, find_packages

setup(
    name="tasknode",
    version="0.1.0",
    description="Post Fiat Foundation Task Node",
    author="Alex Good",
    packages=find_packages(),
    install_requires=[
        "nodetools @ git+https://github.com/postfiatorg/nodetools.git@async#egg=nodetools",
        'numpy',
        'pandas',
        'sqlalchemy',
        'cryptography',
        'xrpl-py',
        'requests',
        'toml',
        'nest_asyncio','brotli','sec-cik-mapper','psycopg2-binary','quandl','schedule','openai','lxml',
        'gspread_dataframe','gspread','oauth2client','discord','anthropic',
        'bs4',
        'plotly',
        'matplotlib',
        'PyNaCl',
        'loguru'
    ],
    python_requires=">=3.11",  # Adjust version as needed
)