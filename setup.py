from setuptools import setup, find_namespace_packages
import os

# Debug: Print current directory and contents
print("Current directory:", os.getcwd())
print("Directory contents:", os.listdir())

# Explicitly find packages in the tasknode directory
packages = find_namespace_packages(include=["tasknode*"])
print("Found packages:", packages)

setup(
    name="tasknode",
    version="0.1.0",
    description="Post Fiat Task Node",
    author="Alex Good",
    author_email="alex@agti.net",
    maintainer="Skelectric",
    maintainer_email="skelectric@postfiat.org",
    packages=packages,
    install_requires=[
        "nodetools @ git+https://github.com/postfiatorg/nodetools.git@main#egg=nodetools",
        # "nodetools @ file:///home/ubuntu/development/nodetools",
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
    python_requires=">=3.11",  # Adjust version as needed,
    entry_points={
        'console_scripts': [
            'tasknode=tasknode.chatbots.pft_discord:main',
        ],
    },
)
