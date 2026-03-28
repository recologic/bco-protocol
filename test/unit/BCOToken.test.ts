import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem } from '../fixtures/deploy';

describe('BCOToken', () => {
  // ──────────────────────────────────────────────
  //  Deployment
  // ──────────────────────────────────────────────

  describe('Deployment', () => {
    it('should set name and symbol', async () => {
      const { token } = await loadFixture(deployFullSystem);
      expect(await token.name()).to.equal('Biocoin');
      expect(await token.symbol()).to.equal('BCO');
    });

    it('should have 18 decimals', async () => {
      const { token } = await loadFixture(deployFullSystem);
      expect(await token.decimals()).to.equal(18);
    });

    it('should have zero initial supply', async () => {
      const { token } = await loadFixture(deployFullSystem);
      expect(await token.totalSupply()).to.equal(0);
    });

    it('should grant DEFAULT_ADMIN_ROLE to deployer', async () => {
      const { token, deployer } =
        await loadFixture(deployFullSystem);
      expect(await token.defaultAdmin()).to.equal(deployer.address);
    });

    it('should grant PAUSER_ROLE to pauser', async () => {
      const { token, pauser, PAUSER_ROLE } =
        await loadFixture(deployFullSystem);
      expect(await token.hasRole(PAUSER_ROLE, pauser.address)).to.be.true;
    });

    it('should grant MINTER_ROLE to registry', async () => {
      const { token, registry, MINTER_ROLE } =
        await loadFixture(deployFullSystem);
      expect(await token.hasRole(MINTER_ROLE, await registry.getAddress())).to
        .be.true;
    });
  });

  // ──────────────────────────────────────────────
  //  Mint
  // ──────────────────────────────────────────────

  describe('mint', () => {
    it('should mint tokens when called by MINTER_ROLE', async () => {
      const { token, registry, deployer, treasury } =
        await loadFixture(deployFullSystem);

      const id = ethers.keccak256(ethers.toUtf8Bytes('PROP-001'));
      await registry.registerDeed(
        id,
        50000,
        '-22.9068,-43.1729',
        'QmTestHash123',
      );

      const expectedTokens = ethers.parseEther('50000');
      expect(await token.balanceOf(treasury.address)).to.equal(expectedTokens);
      expect(await token.totalSupply()).to.equal(expectedTokens);
    });

    it('should REVERT when called by account without MINTER_ROLE', async () => {
      const { token, alice } = await loadFixture(deployFullSystem);

      await expect(
        token.connect(alice).mint(alice.address, ethers.parseEther('1000')),
      ).to.be.reverted;
    });

    it('should REVERT when minting to zero address', async () => {
      const { token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Grant MINTER_ROLE to deployer for direct test
      await token.grantRole(MINTER_ROLE, deployer.address);

      await expect(
        token.mint(ethers.ZeroAddress, ethers.parseEther('1000')),
      ).to.be.revertedWithCustomError(token, 'MintToZeroAddress');
    });

    it('should REVERT when minting zero amount', async () => {
      const { token, deployer, alice, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);

      await expect(
        token.mint(alice.address, 0),
      ).to.be.revertedWithCustomError(token, 'ZeroMintAmount');
    });
  });

  // ──────────────────────────────────────────────
  //  Burn (restricted to BURNER_ROLE)
  // ──────────────────────────────────────────────

  describe('burnFrom', () => {
    it('should burn tokens when called by BURNER_ROLE with allowance', async () => {
      const { token, deployer, alice, MINTER_ROLE, BURNER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.grantRole(BURNER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('1000'));

      // Alice approves deployer (BURNER) to burn
      await token
        .connect(alice)
        .approve(deployer.address, ethers.parseEther('400'));

      await token.burnFrom(alice.address, ethers.parseEther('400'));

      expect(await token.balanceOf(alice.address)).to.equal(
        ethers.parseEther('600'),
      );
      expect(await token.totalSupply()).to.equal(ethers.parseEther('600'));
    });

    it('should REVERT when called by account without BURNER_ROLE', async () => {
      const { token, deployer, alice, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('1000'));

      // Alice tries to burnFrom herself — no BURNER_ROLE
      await expect(
        token.connect(alice).burnFrom(alice.address, ethers.parseEther('100')),
      ).to.be.reverted;
    });

    it('should REVERT when holder tries to burn own tokens directly', async () => {
      const { token, deployer, alice, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('100'));

      // No burn() function exists — only burnFrom with BURNER_ROLE
      // Trying burnFrom without role should revert
      await expect(
        token.connect(alice).burnFrom(alice.address, ethers.parseEther('50')),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  Pause
  // ──────────────────────────────────────────────

  describe('pause / unpause', () => {
    it('should pause when called by PAUSER_ROLE', async () => {
      const { token, pauser } = await loadFixture(deployFullSystem);

      await token.connect(pauser).pause();
      expect(await token.paused()).to.be.true;
    });

    it('should unpause when called by PAUSER_ROLE', async () => {
      const { token, pauser } = await loadFixture(deployFullSystem);

      await token.connect(pauser).pause();
      await token.connect(pauser).unpause();
      expect(await token.paused()).to.be.false;
    });

    it('should block transfers when paused', async () => {
      const { token, deployer, alice, bob, pauser, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('1000'));

      await token.connect(pauser).pause();

      await expect(
        token.connect(alice).transfer(bob.address, ethers.parseEther('100')),
      ).to.be.reverted;
    });

    it('should REVERT when non-PAUSER calls pause', async () => {
      const { token, alice } = await loadFixture(deployFullSystem);

      await expect(token.connect(alice).pause()).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  Transfer
  // ──────────────────────────────────────────────

  describe('transfer', () => {
    it('should transfer tokens between accounts', async () => {
      const { token, deployer, alice, bob, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('1000'));

      await token
        .connect(alice)
        .transfer(bob.address, ethers.parseEther('300'));

      expect(await token.balanceOf(alice.address)).to.equal(
        ethers.parseEther('700'),
      );
      expect(await token.balanceOf(bob.address)).to.equal(
        ethers.parseEther('300'),
      );
    });
  });

  // ──────────────────────────────────────────────
  //  Constructor zero-address reverts
  // ──────────────────────────────────────────────

  describe('constructor zero-address validation', () => {
    it('should REVERT when pauser is zero address', async () => {
      const [deployer] = await ethers.getSigners();
      const BCOToken = await ethers.getContractFactory('BCOToken');

      await expect(
        BCOToken.deploy(0, deployer.address, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(BCOToken, 'ZeroAddress');
    });
  });

  // ──────────────────────────────────────────────
  //  burnFrom zero amount
  // ──────────────────────────────────────────────

  describe('burnFrom zero amount', () => {
    it('should REVERT when burning zero amount', async () => {
      const { token, deployer, alice, MINTER_ROLE, BURNER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.grantRole(BURNER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('1000'));

      await token
        .connect(alice)
        .approve(deployer.address, ethers.parseEther('1000'));

      await expect(
        token.burnFrom(alice.address, 0),
      ).to.be.revertedWithCustomError(token, 'ZeroBurnAmount');
    });
  });

  // ──────────────────────────────────────────────
  //  recoverERC20
  // ──────────────────────────────────────────────

  describe('recoverERC20', () => {
    it('should recover accidentally sent ERC20 tokens', async () => {
      const { token, deployer } = await loadFixture(deployFullSystem);

      // Deploy a mock ERC20 and send tokens to the BCO token contract
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const mockToken = await MockERC20.deploy();
      await mockToken.waitForDeployment();

      const tokenAddress = await token.getAddress();
      const amount = ethers.parseEther('500');
      await mockToken.mint(tokenAddress, amount);

      // Admin recovers
      await expect(
        token.recoverERC20(await mockToken.getAddress(), amount),
      )
        .to.emit(token, 'TokenRecovered')
        .withArgs(await mockToken.getAddress(), deployer.address, amount);

      expect(await mockToken.balanceOf(deployer.address)).to.equal(amount);
      expect(await mockToken.balanceOf(tokenAddress)).to.equal(0);
    });

    it('should REVERT when called by non-admin', async () => {
      const { token, alice } = await loadFixture(deployFullSystem);

      await expect(
        token.connect(alice).recoverERC20(ethers.ZeroAddress, 100),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  contractURI (ERC-7572)
  // ──────────────────────────────────────────────

  describe('contractURI', () => {
    it('should return empty string initially', async () => {
      const { token } = await loadFixture(deployFullSystem);
      expect(await token.contractURI()).to.equal('');
    });

    it('should update URI when called by admin', async () => {
      const { token } = await loadFixture(deployFullSystem);
      const uri = 'ipfs://QmTestMetadata123';
      await token.setContractURI(uri);
      expect(await token.contractURI()).to.equal(uri);
    });

    it('should emit ContractURIUpdated event (ERC-7572, no params)', async () => {
      const { token } = await loadFixture(deployFullSystem);
      await expect(token.setContractURI('https://recologic.io/metadata.json'))
        .to.emit(token, 'ContractURIUpdated');
    });

    it('should allow overwriting URI with a new value', async () => {
      const { token } = await loadFixture(deployFullSystem);
      await token.setContractURI('ipfs://QmFirst');
      await token.setContractURI('ipfs://QmSecond');
      expect(await token.contractURI()).to.equal('ipfs://QmSecond');
    });

    it('should allow clearing URI to empty string', async () => {
      const { token } = await loadFixture(deployFullSystem);
      await token.setContractURI('ipfs://QmSomething');
      await token.setContractURI('');
      expect(await token.contractURI()).to.equal('');
    });

    it('should REVERT when called by non-admin', async () => {
      const { token, alice } = await loadFixture(deployFullSystem);
      await expect(
        token.connect(alice).setContractURI('https://evil.com'),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  setIssuerInfo
  // ──────────────────────────────────────────────

  describe('setIssuerInfo', () => {
    it('should set issuer info when called by admin', async () => {
      const { token } = await loadFixture(deployFullSystem);
      await token.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR');
      expect(await token.issuerName()).to.equal('REcologic Ltda');
      expect(await token.issuerRegistration()).to.equal('12.345.678/0001-90');
      expect(await token.issuerCountry()).to.equal('BR');
    });

    it('should emit IssuerInfoUpdated event', async () => {
      const { token } = await loadFixture(deployFullSystem);
      await expect(token.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR'))
        .to.emit(token, 'IssuerInfoUpdated')
        .withArgs('REcologic Ltda', '12.345.678/0001-90', 'BR');
    });

    it('should allow overwriting issuer info', async () => {
      const { token } = await loadFixture(deployFullSystem);
      await token.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR');
      await token.setIssuerInfo('REcologic S.A.', '12.345.678/0001-90', 'BR');
      expect(await token.issuerName()).to.equal('REcologic S.A.');
    });

    it('should REVERT when called by non-admin', async () => {
      const { token, alice } = await loadFixture(deployFullSystem);
      await expect(
        token.connect(alice).setIssuerInfo('Hacker', '000', 'XX'),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  supportsInterface
  // ──────────────────────────────────────────────

  describe('supportsInterface', () => {
    it('should return true for IAccessControl interface', async () => {
      const { token } = await loadFixture(deployFullSystem);

      // IAccessControl interfaceId: 0x7965db0b
      const iAccessControlId = '0x7965db0b';
      expect(await token.supportsInterface(iAccessControlId)).to.be.true;
    });

    it('should return false for unsupported interface', async () => {
      const { token } = await loadFixture(deployFullSystem);

      // Random interface ID
      expect(await token.supportsInterface('0xdeadbeef')).to.be.false;
    });
  });

});
